# ZeroTerm russh patch

- Base: crates.io `russh` 0.62.4
- Scope: client host-certificate KEX only

Upstream 0.62.4 decodes every server `K_S` value as a plain `PublicKey`.
That prevents an application from advertising OpenSSH certificate host-key
algorithms or validating `@cert-authority` entries.

ZeroTerm's patch:

1. preserves either a `PublicKey` or `Certificate` through client KEX;
2. includes the original certificate blob in the exchange hash;
3. verifies the KEX reply with the certificate's subject public key;
4. exposes `Handler::check_server_certificate`, whose default rejects; and
5. leaves ordinary public-key behavior unchanged.

The application opts into certificate algorithms and performs CA, signature,
validity-window, host-principal, critical-option, and revocation checks.
`crates/zeroterm-ssh/tests/live_sshd.rs` has been exercised against a real
OpenSSH server configured with `HostCertificate`, using a known_hosts file
that contains only a matching `@cert-authority` entry.
