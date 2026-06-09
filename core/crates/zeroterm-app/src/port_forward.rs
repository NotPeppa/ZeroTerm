use serde::{Deserialize, Serialize};

use crate::host::ForwardSpec;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForwardRule {
    #[serde(skip)]
    pub id: String,

    pub host_id: String,

    pub spec: ForwardSpec,
}
