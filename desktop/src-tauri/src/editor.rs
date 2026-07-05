use serde::Serialize;

use crate::sftp::string_error;

const DEFAULT_TEXT_EDIT_MAX_BYTES: u64 = 5 * 1024 * 1024;
pub(crate) const HARD_TEXT_EDIT_MAX_BYTES: u64 = 8 * 1024 * 1024;

pub(crate) fn normalize_text_edit_limit(max_bytes: Option<u64>) -> u64 {
    let requested = max_bytes.unwrap_or(DEFAULT_TEXT_EDIT_MAX_BYTES);
    requested.clamp(1, HARD_TEXT_EDIT_MAX_BYTES)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTextFileDto {
    pub path: String,
    pub size: u64,
    pub content: String,
    pub encoding: &'static str,
}

pub(crate) fn decode_editor_text(
    path: &str,
    bytes: Vec<u8>,
) -> Result<(String, &'static str), String> {
    if bytes.contains(&0) {
        return Err(string_error(format!(
            "`{path}` looks like binary data (contains NUL bytes)"
        )));
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok((content, "UTF-8")),
        Err(err) => {
            let bytes = err.into_bytes();
            for encoding in [
                encoding_rs::GBK,
                encoding_rs::WINDOWS_1252,
                encoding_rs::SHIFT_JIS,
                encoding_rs::EUC_KR,
            ] {
                let (content, _, had_errors) = encoding.decode(&bytes);
                if !had_errors {
                    return Ok((content.into_owned(), encoding.name()));
                }
            }
            let (content, _, _) = encoding_rs::GBK.decode(&bytes);
            Ok((content.into_owned(), "GBK (lossy)"))
        }
    }
}
