// Regression checks for the service manager's journal viewer wiring.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const frontend = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const commands = fs.readFileSync(path.join(__dirname, "../src-tauri/src/commands.rs"), "utf8");
const lib = fs.readFileSync(path.join(__dirname, "../src-tauri/src/lib.rs"), "utf8");

assert.match(frontend, /data-service-logs/);
assert.match(frontend, /showSystemServiceLogs\(unit, scope\)/);
assert.match(frontend, /invoke\(options\.invoke, \{ hostId, unit, scope \}\)/);
assert.match(frontend, /invoke: "system_service_logs"/);
assert.match(frontend, /--output=short-iso --lines=300 --unit/);
assert.match(commands, /pub async fn system_service_logs\(/);
assert.match(commands, /journalctl/);
assert.match(commands, /MAX_SERVICE_LOG_BYTES: usize = 2 \* 1024 \* 1024/);
assert.match(lib, /commands::system_service_logs/);

console.log("service-logs.test.js: passed");
