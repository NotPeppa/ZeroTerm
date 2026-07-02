//! SFTP client built on top of `russh-sftp`.
//!
//! Open via [`crate::Session::sftp`]. Two flavours of API:
//!
//!   - **Streaming** ([`Sftp::download_to_writer`] / [`Sftp::upload_from_reader`])
//!     read/write in chunks, report progress through a caller-supplied
//!     callback, and honour a [`tokio_util::sync::CancellationToken`].
//!     Use these for any transfer where size matters or the user might
//!     change their mind.
//!
//!   - **Whole-file convenience** ([`Sftp::download_to_vec`] /
//!     [`Sftp::upload_from_slice`]) thin wrappers around the streaming
//!     primitives, for small files where progress and cancel aren't
//!     worth the ceremony.
//!
//! Default chunk size is 32 KiB — large enough to amortise per-packet
//! overhead, small enough that progress updates feel responsive.

use std::io::SeekFrom;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::error::SshError;

/// Categorisation of a remote path entry. Anything we don't actively
/// distinguish (sockets, devices, …) gets bucketed into `Other` so the
/// public API doesn't leak russh-sftp's enum variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    File,
    Dir,
    Symlink,
    Other,
}

impl From<FileType> for FileKind {
    fn from(t: FileType) -> Self {
        match t {
            FileType::File => FileKind::File,
            FileType::Dir => FileKind::Dir,
            FileType::Symlink => FileKind::Symlink,
            _ => FileKind::Other,
        }
    }
}

/// One entry returned by [`Sftp::list`].
#[derive(Debug, Clone)]
pub struct DirEntry {
    pub name: String,
    pub kind: FileKind,
    pub size: u64,
    /// Last modification time in milliseconds since the Unix epoch.
    /// `None` when the server didn't report mtime (rare but possible
    /// for some non-OpenSSH servers).
    pub modified_unix_ms: Option<i64>,
}

/// Metadata returned by [`Sftp::stat`].
#[derive(Debug, Clone)]
pub struct FileMetadata {
    pub kind: FileKind,
    pub size: u64,
    pub permissions_mode: Option<u32>,
    /// Last modification time in milliseconds since the Unix epoch.
    /// `None` when the server didn't report mtime.
    pub modified_unix_ms: Option<i64>,
}

/// One progress update during a streaming transfer. `total` is `None`
/// for uploads driven by a reader of unknown length.
#[derive(Debug, Clone, Copy)]
pub struct ProgressTick {
    pub bytes_done: u64,
    pub total: Option<u64>,
}

/// Default streaming chunk size. Kept fairly large so single-flight SFTP
/// reads spend less time paying round-trip overhead on higher-latency
/// links while still remaining responsive to cancel / progress updates.
pub const DEFAULT_CHUNK: usize = 512 * 1024;

/// Default number of READ requests kept in flight against a single file
/// during a parallel download. A single-flight SFTP read is bounded by
/// `chunk / RTT`; keeping N requests pipelined lifts that to roughly
/// `N * chunk / RTT`, which is what saturates a high-latency link. 8 is a
/// balance between throughput and server load (`MaxSessions`, memory).
pub const DEFAULT_DOWNLOAD_PARALLELISM: usize = 8;

const MIN_CHUNK_SIZE: usize = 1024;

/// Live SFTP channel. Drop closes the underlying SSH channel.
pub struct Sftp {
    inner: SftpSession,
}

impl Sftp {
    pub(crate) fn from_session(session: SftpSession) -> Self {
        Self { inner: session }
    }

    /// List the entries directly under `path`. Symlinks are reported as
    /// `Symlink` (not followed). The order is server-defined.
    pub async fn list(&self, path: &str) -> Result<Vec<DirEntry>, SshError> {
        let entries = self.inner.read_dir(path).await.map_err(map_sftp_err)?;
        let out = entries
            .into_iter()
            .map(|e| {
                let metadata = e.metadata();
                DirEntry {
                    name: e.file_name(),
                    kind: metadata.file_type().into(),
                    size: metadata.size.unwrap_or(0),
                    modified_unix_ms: metadata.mtime.map(|s| (s as i64) * 1000),
                }
            })
            .collect();
        Ok(out)
    }

    pub async fn stat(&self, path: &str) -> Result<FileMetadata, SshError> {
        let metadata = self
            .inner
            .metadata(path.to_string())
            .await
            .map_err(map_sftp_err)?;
        Ok(FileMetadata {
            kind: metadata.file_type().into(),
            size: metadata.size.unwrap_or(0),
            permissions_mode: metadata.permissions,
            modified_unix_ms: metadata.mtime.map(|s| (s as i64) * 1000),
        })
    }

    // -- streaming -------------------------------------------------------

    /// Stream a remote file into `dest` in `chunk_size`-byte blocks.
    /// `on_progress` is invoked after every chunk with the running total
    /// (and the file's known size, if `stat` worked). The transfer
    /// aborts with [`SshError::Cancelled`] if `cancel` fires between
    /// chunks. Returns the total bytes transferred.
    pub async fn download_to_writer<W, F>(
        &self,
        remote: &str,
        dest: &mut W,
        chunk_size: usize,
        cancel: CancellationToken,
        mut on_progress: F,
    ) -> Result<u64, SshError>
    where
        W: tokio::io::AsyncWrite + Unpin,
        F: FnMut(ProgressTick),
    {
        let total = self.stat(remote).await.ok().map(|m| m.size);

        let mut file = self
            .inner
            .open(remote.to_string())
            .await
            .map_err(map_sftp_err)?;
        let chunk = chunk_size.max(MIN_CHUNK_SIZE);
        let mut buf = vec![0u8; chunk];
        let mut bytes_done: u64 = 0;

        // Emit a 0-byte tick so callers can render "starting" UI before the
        // first chunk lands. Cheap and saves a special-case in the consumer.
        on_progress(ProgressTick {
            bytes_done: 0,
            total,
        });

        loop {
            if cancel.is_cancelled() {
                return Err(SshError::Cancelled);
            }
            let n = file.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            dest.write_all(&buf[..n]).await?;
            bytes_done += n as u64;
            on_progress(ProgressTick { bytes_done, total });
        }
        dest.flush().await?;
        Ok(bytes_done)
    }

    /// Parallel variant of [`Self::download_to_writer`]. Opens `parallelism`
    /// independent file handles and keeps that many `READ` requests in flight
    /// against the same remote file, each fetching a distinct `chunk_size`
    /// slice by offset. A single-flight SFTP read is bounded by
    /// `chunk / RTT`; pipelining N reads lifts the ceiling toward
    /// `N * chunk / RTT`, which is what actually saturates a high-latency
    /// link.
    ///
    /// Completed slices are reordered and written to `dest` strictly in
    /// offset order, so `dest` only needs to be a plain sequential writer.
    /// Falls back to the serial path when the file can't be sized (work can't
    /// be divided) or is small enough that pipelining wouldn't pay off.
    ///
    /// Each non-final slice must come back fully read; a short read there means
    /// the file changed underneath us and the transfer aborts rather than
    /// silently writing a corrupt result.
    pub async fn download_to_writer_parallel<W, F>(
        &self,
        remote: &str,
        dest: &mut W,
        chunk_size: usize,
        parallelism: usize,
        cancel: CancellationToken,
        mut on_progress: F,
    ) -> Result<u64, SshError>
    where
        W: tokio::io::AsyncWrite + Unpin,
        F: FnMut(ProgressTick),
    {
        let chunk = chunk_size.max(MIN_CHUNK_SIZE);
        let total = self.stat(remote).await.ok().map(|m| m.size);

        // Divide-and-pipeline only helps with a known size larger than one
        // chunk. Otherwise defer to the serial streamer (same semantics).
        let total = match total {
            Some(t) if parallelism > 1 && t > chunk as u64 => t,
            _ => {
                return self
                    .download_to_writer(remote, dest, chunk, cancel, on_progress)
                    .await
            }
        };

        let total_chunks = total.div_ceil(chunk as u64);
        let workers = parallelism.min(total_chunks as usize).max(1);

        // One handle per worker: each carries an independent cursor, so they
        // can seek + read concurrently against the same path.
        let mut files = Vec::with_capacity(workers);
        for _ in 0..workers {
            let f = self
                .inner
                .open(remote.to_string())
                .await
                .map_err(map_sftp_err)?;
            files.push(f);
        }

        // Process fixed-size windows instead of letting workers read
        // arbitrarily far ahead. That preserves the streaming contract: memory
        // is bounded by `workers * chunk`, even if an early slice is slow.
        let mut next_offset: u64 = 0;
        let mut write_pos: u64 = 0;
        let mut bytes_done: u64 = 0;

        on_progress(ProgressTick {
            bytes_done: 0,
            total: Some(total),
        });

        while next_offset < total {
            if cancel.is_cancelled() {
                return Err(SshError::Cancelled);
            }

            let remaining_chunks = (total - next_offset).div_ceil(chunk as u64) as usize;
            let window = workers.min(remaining_chunks);
            let mut join = tokio::task::JoinSet::new();

            for _ in 0..window {
                let mut f = files
                    .pop()
                    .expect("window size never exceeds available SFTP file handles");
                let offset = next_offset;
                next_offset = next_offset.saturating_add(chunk as u64);
                let want = (total - offset).min(chunk as u64) as usize;
                let cancel = cancel.clone();

                join.spawn(async move {
                    if cancel.is_cancelled() {
                        return Err(SshError::Cancelled);
                    }
                    f.seek(SeekFrom::Start(offset)).await?;
                    let mut buf = vec![0u8; want];
                    match read_fully(&mut f, &mut buf).await {
                        Ok(n) if n == want => Ok((offset, buf, f)),
                        Ok(_) => Err(SshError::Io(io_other("remote file shrank during download"))),
                        Err(e) => Err(SshError::Io(e)),
                    }
                });
            }

            let mut window_data = Vec::with_capacity(window);
            while let Some(result) = tokio::select! {
                _ = cancel.cancelled() => {
                    join.shutdown().await;
                    return Err(SshError::Cancelled);
                }
                result = join.join_next() => result,
            } {
                match result {
                    Ok(Ok((offset, data, f))) => {
                        files.push(f);
                        window_data.push((offset, data));
                    }
                    Ok(Err(e)) => {
                        join.shutdown().await;
                        return Err(e);
                    }
                    Err(e) => {
                        join.shutdown().await;
                        return Err(SshError::Io(io_other(&format!(
                            "sftp download worker failed: {e}"
                        ))));
                    }
                }
            }

            window_data.sort_by_key(|(offset, _)| *offset);
            for (offset, data) in window_data {
                if offset != write_pos {
                    return Err(SshError::Io(io_other(
                        "sftp download window completed out of order",
                    )));
                }
                dest.write_all(&data).await?;
                write_pos += data.len() as u64;
                bytes_done += data.len() as u64;
                on_progress(ProgressTick {
                    bytes_done,
                    total: Some(total),
                });
            }
        }
        dest.flush().await?;
        Ok(bytes_done)
    }
    /// shape as [`Self::download_to_writer`]; supply `size_hint` if you
    /// know how many bytes are coming so the progress UI can show a
    /// percentage.
    pub async fn upload_from_reader<R, F>(
        &self,
        remote: &str,
        src: &mut R,
        chunk_size: usize,
        size_hint: Option<u64>,
        cancel: CancellationToken,
        mut on_progress: F,
    ) -> Result<u64, SshError>
    where
        R: tokio::io::AsyncRead + Unpin,
        F: FnMut(ProgressTick),
    {
        let mut file = self
            .inner
            .create(remote.to_string())
            .await
            .map_err(map_sftp_err)?;
        let chunk = chunk_size.max(MIN_CHUNK_SIZE);
        let mut buf = vec![0u8; chunk];
        let mut bytes_done: u64 = 0;

        on_progress(ProgressTick {
            bytes_done: 0,
            total: size_hint,
        });

        loop {
            if cancel.is_cancelled() {
                // Best-effort: shut the file handle so the partial upload
                // doesn't keep an open channel.
                let _ = file.shutdown().await;
                return Err(SshError::Cancelled);
            }
            let n = src.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).await?;
            bytes_done += n as u64;
            // Don't emit the final 100% tick here — `write_all` only
            // queues the write into the SSH channel; the bytes aren't
            // truly acknowledged until `flush` + `shutdown` below. If
            // we reported 100% now the progress bar would sit at full
            // while the remote finishes ACKing the final writes, which
            // looks like a hang.
            if bytes_done < size_hint.unwrap_or(u64::MAX) {
                on_progress(ProgressTick {
                    bytes_done,
                    total: size_hint,
                });
            }
        }
        file.flush().await?;
        file.shutdown().await?;
        // Every queued write has now been ACK'd by the remote — emit
        // the final tick so the bar reaches 100% exactly when the
        // transfer is truly complete, instead of when the last write
        // was merely queued.
        on_progress(ProgressTick {
            bytes_done,
            total: size_hint,
        });
        Ok(bytes_done)
    }

    // -- whole-file convenience -----------------------------------------

    /// Read the entire remote file into memory. Suitable for configs
    /// and small payloads. For large files reach for
    /// [`Self::download_to_writer`] so you can stream and report
    /// progress.
    pub async fn download_to_vec(&self, remote: &str) -> Result<Vec<u8>, SshError> {
        let mut buf = Vec::new();
        self.download_to_writer(
            remote,
            &mut buf,
            DEFAULT_CHUNK,
            CancellationToken::new(),
            |_| {},
        )
        .await?;
        Ok(buf)
    }

    /// Write `data` to `remote`, replacing any existing file. For large
    /// payloads use [`Self::upload_from_reader`].
    pub async fn upload_from_slice(&self, remote: &str, data: &[u8]) -> Result<(), SshError> {
        let mut cursor = std::io::Cursor::new(data);
        self.upload_from_reader(
            remote,
            &mut cursor,
            DEFAULT_CHUNK,
            Some(data.len() as u64),
            CancellationToken::new(),
            |_| {},
        )
        .await?;
        Ok(())
    }

    // -- mutations -------------------------------------------------------

    pub async fn rename(&self, from: &str, to: &str) -> Result<(), SshError> {
        self.inner
            .rename(from.to_string(), to.to_string())
            .await
            .map_err(map_sftp_err)?;
        Ok(())
    }

    pub async fn remove_file(&self, path: &str) -> Result<(), SshError> {
        self.inner
            .remove_file(path.to_string())
            .await
            .map_err(map_sftp_err)?;
        Ok(())
    }

    pub async fn remove_dir(&self, path: &str) -> Result<(), SshError> {
        self.inner
            .remove_dir(path.to_string())
            .await
            .map_err(map_sftp_err)?;
        Ok(())
    }

    pub async fn create_dir(&self, path: &str) -> Result<(), SshError> {
        self.inner
            .create_dir(path.to_string())
            .await
            .map_err(map_sftp_err)?;
        Ok(())
    }

    pub async fn chmod(&self, path: &str, mode: u32) -> Result<(), SshError> {
        let mut attrs = self
            .inner
            .metadata(path.to_string())
            .await
            .map_err(map_sftp_err)?;
        let file_type_bits = attrs.permissions.unwrap_or_default() & 0o170000;
        attrs.permissions = Some(file_type_bits | (mode & 0o7777));
        self.inner
            .set_metadata(path.to_string(), attrs)
            .await
            .map_err(map_sftp_err)?;
        Ok(())
    }
}

fn map_sftp_err(e: russh_sftp::client::error::Error) -> SshError {
    SshError::Sftp(e.to_string())
}

fn io_other(msg: &str) -> std::io::Error {
    std::io::Error::other(msg.to_string())
}

/// Read until `buf` is full or EOF. Returns the number of bytes actually
/// read; a value less than `buf.len()` means EOF was hit early.
async fn read_fully<R>(reader: &mut R, buf: &mut [u8]) -> std::io::Result<usize>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut filled = 0;
    while filled < buf.len() {
        let n = reader.read(&mut buf[filled..]).await?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}
