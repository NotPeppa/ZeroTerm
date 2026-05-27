use serde::{Deserialize, Serialize};

/// A host group node in the saved hierarchy. Serialized as JSON inside a
/// vault record under kind `host_group`; `id` is populated from the vault
/// record id on read and skipped on serialize so it never lands in the
/// encrypted plaintext (it's already the plaintext's identity in the
/// store).
///
/// `parent_id` is the vault id of another `HostGroup` and forms a tree.
/// `None` means root. The tree is **eventually consistent across devices**
/// — a peer may delete a parent while another peer still references it.
/// The frontend renders such orphans as roots; we do not auto-rewrite the
/// vault for those cases.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostGroup {
    #[serde(skip)]
    pub id: String,

    pub name: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,

    /// Stable per-parent ordering. UI sorts ascending; ties broken by name.
    #[serde(default)]
    pub sort_order: i32,
}
