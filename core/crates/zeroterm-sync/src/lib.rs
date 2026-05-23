//! ZeroTerm sync layer.
//!
//! Public surface is the new RFC-002 repo-based engine (modules below).
//! The pre-RFC-002 single-blob backends — filesystem / WebDAV / S3 —
//! still compile under the `legacy-backends` feature so the eventual
//! Phase 5 port doesn't have to re-derive the wire protocol from
//! scratch. With the feature off (the default), the legacy types are
//! invisible and their heavyweight transport deps (reqwest, aws-*,
//! quick-xml) don't enter the build.

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

#[cfg(feature = "legacy-backends")]
pub mod legacy;
