use serde::{Deserialize, Serialize};

/// An OpenAI-compatible provider profile stored inside the encrypted vault.
/// The API key deliberately stays in this encrypted record and is never
/// returned by list operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProfile {
    #[serde(skip)]
    pub id: String,
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub reasoning_effort: String,
}
