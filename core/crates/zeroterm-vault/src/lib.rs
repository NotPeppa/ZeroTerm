//! ZeroTerm encrypted vault.
//!
//! Stores credentials, host configurations, and snippets with end-to-end
//! crypto suitable for shipping over an untrusted sync channel later.
//!
//! Usage:
//!   1. [`Vault::create`] on first run, or [`Vault::unlock`] thereafter.
//!   2. [`Vault::insert`] / [`Vault::update`] / [`Vault::delete`] for
//!      writes; [`Vault::get`] / [`Vault::list`] for reads.
//!   3. Drop the [`Vault`] to lock it (master key is zeroized on drop).

mod crypto;
mod error;
mod vault;

pub use crypto::Argon2Params;
pub use error::VaultError;
pub use vault::{DirtyRecord, FullRecord, Vault};
pub use zeroterm_store::ConflictRow;
