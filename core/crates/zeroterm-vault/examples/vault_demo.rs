//! End-to-end demo of the vault: create → insert → lock → unlock → list.
//!
//! Run with:
//!   cargo run --release -p zeroterm-vault --example vault_demo

use anyhow::Result;
use tempfile::tempdir;
use zeroterm_vault::{Argon2Params, Vault, VaultError};

const PASSWORD: &str = "correct horse battery staple";
const WRONG_PASSWORD: &str = "wrong horse";

// 8 MiB / 1 iter is fast enough for an interactive demo on most laptops.
// In production we use the defaults (64 MiB / 3 iter) — see RFC §4.1.
fn demo_params() -> Argon2Params {
    Argon2Params {
        m_cost: 8 * 1024,
        t_cost: 1,
        p_cost: 1,
    }
}

fn main() -> Result<()> {
    let dir = tempdir()?;
    let path = dir.path().join("zeroterm.vault");
    println!("vault path: {}", path.display());

    println!("\n[1] Create vault and insert three records");
    {
        let vault = Vault::create_with_params(&path, PASSWORD, demo_params())?;

        let h1 = vault.insert(
            "host",
            br#"{"name":"prod-web-1","host":"10.0.0.10","port":22,"user":"deploy"}"#,
        )?;
        let h2 = vault.insert(
            "host",
            br#"{"name":"staging","host":"10.0.0.11","port":22,"user":"deploy"}"#,
        )?;
        let s1 = vault.insert("snippet", b"docker logs -f --tail 200 app")?;

        println!("  inserted host: {}", h1);
        println!("  inserted host: {}", h2);
        println!("  inserted snippet: {}", s1);
        println!("  current local version: {}", vault.current_version()?);
    } // vault drops here → master key zeroized

    println!("\n[2] Reopen with wrong password — must reject");
    match Vault::unlock(&path, WRONG_PASSWORD) {
        Err(VaultError::AuthenticationFailed) => println!("  rejected as expected"),
        Err(e) => anyhow::bail!("expected AuthenticationFailed, got {e:?}"),
        Ok(_) => anyhow::bail!("vault opened with wrong password — bug"),
    }

    println!("\n[3] Reopen with correct password and list hosts");
    let vault = Vault::unlock(&path, PASSWORD)?;
    let hosts = vault.list("host")?;
    for (id, plaintext) in &hosts {
        println!("  {}  →  {}", id, String::from_utf8_lossy(plaintext));
    }
    let snippets = vault.list("snippet")?;
    for (id, plaintext) in &snippets {
        println!("  {}  →  {}", id, String::from_utf8_lossy(plaintext));
    }

    println!("\n[4] Update one host, delete one snippet");
    let first_host_id = hosts[0].0.clone();
    vault.update(
        &first_host_id,
        br#"{"name":"prod-web-1","host":"10.0.0.10","port":2222,"user":"deploy"}"#,
    )?;
    let snippet_id = &snippets[0].0;
    vault.delete(snippet_id)?;
    println!("  updated {} (port → 2222)", first_host_id);
    println!("  deleted {}", snippet_id);

    println!("\n[5] Final state");
    for (id, plaintext) in vault.list("host")? {
        println!("  host    {}  →  {}", id, String::from_utf8_lossy(&plaintext));
    }
    let live_snippets = vault.list("snippet")?;
    if live_snippets.is_empty() {
        println!("  snippets: <empty> (tombstoned)");
    } else {
        for (id, plaintext) in live_snippets {
            println!("  snippet {}  →  {}", id, String::from_utf8_lossy(&plaintext));
        }
    }
    println!("  current local version: {}", vault.current_version()?);

    println!("\nDemo complete.");
    Ok(())
}
