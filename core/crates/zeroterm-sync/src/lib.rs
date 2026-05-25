//! ZeroTerm sync layer.
//!
//! Public surface is the RFC-002 repo-based engine (modules below).

pub mod adapter;
pub mod clock;
pub mod crypto;
pub mod engine;
pub mod error;
pub mod event;
pub mod keyring;
pub mod local_store;
pub mod manifest;
pub mod repo;
pub mod snapshot;
