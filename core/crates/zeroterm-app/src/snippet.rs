use serde::{Deserialize, Serialize};

/// A reusable command snippet. Serialized as JSON inside a vault record
/// under kind `snippet`; `id` is populated from the vault record id on
/// read and skipped on serialize so it never lands in the encrypted
/// plaintext (it's already the plaintext's identity in the store).
///
/// `group` is a free-form label, **not** a reference to a separate
/// record — snippet grouping is intentionally flat. An empty string is
/// rendered by the frontend as the default "未分组" bucket. Renaming or
/// deleting a "group" is therefore a batch rewrite/removal of the member
/// snippets (see [`crate::App::rename_snippet_group`] /
/// [`crate::App::delete_snippet_group`]). Keeping the group inline means
/// each record stays self-contained and the sync channel never has to
/// reconcile a snippet against a group record that hasn't arrived yet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    #[serde(skip)]
    pub id: String,

    pub title: String,

    pub command: String,

    /// Free-form group label. Empty means ungrouped.
    #[serde(default)]
    pub group: String,

    /// Stable ordering hint within a group. UI sorts ascending; ties
    /// broken by title. Defaults to 0 for snippets created before this
    /// field existed.
    #[serde(default)]
    pub sort_order: i32,
}
