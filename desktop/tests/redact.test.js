// Regression tests for the local AI redaction (redact.js).
//
// Run with: node desktop/tests/redact.test.js
// Zero dependencies — a tiny assert harness so it runs anywhere Node does.
//
// Focus is the 2026-07 audit's FE findings:
//   FE-1: quoted multi-word values were truncated at the first space,
//         leaking the tail as plaintext.
//   FE-2: an unbounded key-name prefix caused O(n^2) regex backtracking
//         (ReDoS) on long keyword-free input.
//   FE-7: ANSI escapes splitting a keyword/value bypassed redaction.

const { redactSensitiveText } = require("../frontend/redact.js");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("  FAIL: " + msg);
  }
}

function redactsAllOf(input, leaks) {
  const out = redactSensitiveText(input);
  for (const leak of leaks) {
    assert(!out.includes(leak), `"${leak}" leaked from ${JSON.stringify(input)} => ${JSON.stringify(out)}`);
  }
  assert(out.includes("[REDACTED"), `expected some redaction in ${JSON.stringify(out)}`);
}

// --- FE-1: quoted multi-word values ---------------------------------

redactsAllOf('export DB_PASSWORD="correct horse battery staple"', [
  "correct",
  "horse",
  "battery",
  "staple",
]);
redactsAllOf("password='hunter two three'", ["hunter", "two", "three"]);
redactsAllOf('"api_key":"abc def ghi"', ["abc", "def", "ghi"]);
redactsAllOf("client_secret = \"a b c d\"", ["a b c", "b c d"]);

// Closing quote is re-emitted so the surrounding text stays balanced.
{
  const out = redactSensitiveText('token="multi word value"');
  assert(out === 'token="[REDACTED_SECRET]"', `balanced quotes: ${JSON.stringify(out)}`);
}

// --- bare + safe values keep working --------------------------------

{
  const out = redactSensitiveText("token=abc123def");
  assert(out.includes("[REDACTED_SECRET]") && !out.includes("abc123def"), `bare value: ${out}`);
}
{
  // Placeholder / ${VAR} style values must NOT be redacted.
  const out = redactSensitiveText("password=${DB_PASSWORD}");
  assert(out.includes("${DB_PASSWORD}"), `env-var placeholder preserved: ${out}`);
}
{
  const out = redactSensitiveText("PermitRootLogin without-password");
  // "without-password" isn't a key=value, must be left intact.
  assert(out.includes("without-password"), `sshd_config value preserved: ${out}`);
}

// --- FE-7: ANSI escapes must not defeat redaction -------------------

{
  const out = redactSensitiveText("pass\x1b[1mword=topsecret");
  assert(!out.includes("topsecret"), `ANSI-split keyword leaked: ${JSON.stringify(out)}`);
  assert(!out.includes("\x1b"), `ANSI escape survived: ${JSON.stringify(out)}`);
}
{
  const out = redactSensitiveText("API_KEY=\x1b[32msk-abcdefghijklmnopqrstuv\x1b[0m");
  assert(!out.includes("sk-abcdefghijklmnopqrstuv"), `ANSI-wrapped secret leaked: ${out}`);
}

// --- FE-2: ReDoS — long input must stay fast ------------------------

function timed(fn) {
  const t0 = Date.now();
  fn();
  return Date.now() - t0;
}

{
  const big = "a".repeat(200_000);
  const dt = timed(() => redactSensitiveText(big));
  assert(dt < 1000, `200k plain chars took ${dt}ms (ReDoS?)`);
}
{
  // Pathological: a long keyword-free [\w.-] run — the exact shape that
  // made the unbounded prefix backtrack quadratically.
  const big = "password_" + "abcdefgh.".repeat(25_000);
  const dt = timed(() => redactSensitiveText(big));
  assert(dt < 1000, `240k keyword-prefixed chars took ${dt}ms (ReDoS?)`);
}
{
  // Input beyond the cap is truncated (defense in depth), not dropped
  // silently.
  const out = redactSensitiveText("x".repeat(300_000));
  assert(out.includes("[REDACTED_TRUNCATED]"), "oversized input should be marked truncated");
  assert(out.length < 300_000, "oversized input should be truncated");
}

// --- idempotence (history is re-redacted every request) -------------

{
  const once = redactSensitiveText('DB_PASSWORD="a b c"');
  const twice = redactSensitiveText(once);
  assert(once === twice, `not idempotent: ${once} !== ${twice}`);
}

console.log(`\nredact.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
