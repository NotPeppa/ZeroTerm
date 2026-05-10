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

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
}

/// Metadata returned by [`Sftp::stat`].
#[derive(Debug, Clone)]
pub struct FileMetadata {
    pub kind: FileKind,
    pub size: u64,
}

/// One progress update during a streaming transfer. `total` is `None`
/// for uploads driven by a reader of unknown length.
#[derive(Debug, Clone, Copy)]
pub struct ProgressTick {
    pub bytes_done: u64,
    pub total: Option<u64>,
}

/// Default streaming chunk size. Tuned for SFTP packet overhead vs
/// progress responsiveness.
pub const DEFAULT_CHUNK: usize = 32 * 1024;

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
        let chunk = chunk_size.max(1024);
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
            on_progress(ProgressTick {
                bytes_done,
                total,
            });
        }
        dest.flush().await?;
        Ok(bytes_done)
    }

    /// Stream `src` into `remote`, replacing any existing file. Same
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
        let chunk = chunk_size.max(1024);
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
            on_progress(ProgressTick {
                bytes_done,
                total: size_hint,
            });
        }
        file.flush().await?;
        file.shutdown().await?;
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
}

fn map_sftp_err(e: russh_sftp::client::error::Error) -> SshError {
    SshError::Sftp(e.to_string())
}
