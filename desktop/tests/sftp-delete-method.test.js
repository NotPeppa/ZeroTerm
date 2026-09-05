// Regression checks for choosing the remote directory deletion method.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../frontend/index.html"), "utf8");
const start = source.indexOf("async function removePaneEntry");
const end = source.indexOf("\nasync function sftpDeleteEntry", start);

if (start < 0 || end < 0) throw new Error("remote delete dispatch helper was not found");

async function run() {
  const calls = [];
  const { removePaneEntry } = vm.runInNewContext(
    `${source.slice(start, end)}; ({ removePaneEntry })`,
    {
      isLocalPane: (pane) => pane.local === true,
      invoke: async (command, args) => calls.push({ command, args }),
    },
  );

  await removePaneEntry({ local: false, sftpId: 7 }, { kind: "dir" }, "/srv/app", "command");
  await removePaneEntry({ local: false, sftpId: 7 }, { kind: "dir" }, "/srv/app", "sftp");
  await removePaneEntry({ local: false, sftpId: 7 }, { kind: "file" }, "/srv/app/a", "command");
  await removePaneEntry({ local: true }, { kind: "dir" }, "/tmp/app", null);

  const commands = calls.map((call) => call.command);
  const expected = ["sftp_remove_dir_command", "sftp_remove_dir", "sftp_remove", "local_remove_dir"];
  if (JSON.stringify(commands) !== JSON.stringify(expected)) {
    throw new Error(`unexpected delete dispatch: ${JSON.stringify(commands)}`);
  }

  for (const id of [
    "sftp-delete-method-overlay",
    "sftp-delete-method-close",
    "sftp-delete-method-sftp",
    "sftp-delete-method-command-button",
    "sftp-delete-method-command",
  ]) {
    if (!html.includes(`id="${id}"`)) throw new Error(`missing delete dialog control: ${id}`);
  }
  if (!html.includes('role="dialog"') || !html.includes('aria-modal="true"')) {
    throw new Error("delete method dialog is missing modal accessibility semantics");
  }

  console.log("sftp-delete-method.test.js: passed");
}

run();
