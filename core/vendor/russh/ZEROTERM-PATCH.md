# ZeroTerm russh patch

- Base: crates.io `russh` 0.62.4
- Scope: client host-certificate KEX; agent-server stream serving

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

## Agent server additions

`keys::agent::server` gains:

1. `serve_stream(stream, identities)` — answers the agent protocol on a
   single already-connected stream with a fixed, caller-supplied identity
   set. Used to lend a specific vault key over a forwarded
   `auth-agent@openssh.com` channel (server-to-server copies) without
   exposing the whole system agent.
2. Sign requests now honor the client's `SSH_AGENT_RSA_SHA2_256`/`_512`
   flags instead of always signing RSA with SHA-1, which OpenSSH ≥ 8.8
   rejects by default.
