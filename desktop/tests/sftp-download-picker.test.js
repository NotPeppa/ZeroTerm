// Regression checks ensuring SFTP file/folder downloads use the native backend
// pickers (`pick_save_file` / `pick_local_directory`) instead of
// `plugin:dialog|save` / `plugin:dialog|open`, which attach a sheet to macOS
// Overlay windows and can freeze when selecting a save location.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const start = source.indexOf("function getSftpDownloadDefaultDirectory()");
const end = source.indexOf("\nfunction externalSftpEditKey(", start);

if (start < 0 || end < 0) {
  throw new Error("sftpDownloadFile helpers were not found in main.js");
}

async function run() {
  const calls = [];
  const { getSftpDownloadDefaultDirectory, sftpDownloadFile } = vm.runInNewContext(
    `${source.slice(start, end)}; ({ getSftpDownloadDefaultDirectory, sftpDownloadFile })`,
    {
      SETTINGS_KEY_SFTP_LOCAL_DIR: "zeroterm.settings.sftp.local_dir",
      localStorage: {
        getItem: (key) => (key === "zeroterm.settings.sftp.local_dir" ? "/Users/tester/SavedDir" : null),
      },
      sftpPanes: {
        left: { key: "left", local: true, localConnected: true, path: "/Users/tester/LocalPane" },
        right: { key: "right", local: false, localConnected: false, path: "/srv/data" },
      },
      isLocalPane: (pane) => pane.local === true,
      joinPath: (a, b) => `${a.replace(/\/+$/, "")}/${b}`,
      joinPanePath: (pane, name) => `${pane.path.replace(/\/+$/, "")}/${name}`,
      planOverwriteForLocalPath: async () => ({ proceed: true, overwrite: false }),
      invokeSftpTransferWithRetry: async (_meta, fn) => fn(),
      formatSize: (n) => `${n} B`,
      t: (k) => k,
      normalizeSftpError: (e) => ({ code: "OTHER", message: String(e) }),
      showOverwriteConfirm: async () => false,
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "pick_save_file") return "/Users/tester/LocalPane/report.log";
        if (command === "pick_local_directory") return "/Users/tester/LocalPane";
        if (command === "sftp_download") return 128;
        if (command === "sftp_copy_entry_between_panes") return 0;
        throw new Error(`unexpected command: ${command}`);
      },
    },
  );

  if (getSftpDownloadDefaultDirectory() !== "/Users/tester/LocalPane") {
    throw new Error(`unexpected default dir: ${getSftpDownloadDefaultDirectory()}`);
  }

  const remotePane = { key: "right", sftpId: 42, path: "/srv/data", statusEl: { textContent: "" } };
  await sftpDownloadFile(remotePane, { kind: "file", name: "report.log" });
  await sftpDownloadFile(remotePane, { kind: "dir", name: "logs" });

  const filePick = calls.find((c) => c.command === "pick_save_file");
  const dirPick = calls.find((c) => c.command === "pick_local_directory");
  if (!filePick || filePick.args.defaultName !== "report.log" || filePick.args.defaultPath !== "/Users/tester/LocalPane") {
    throw new Error(`unexpected file pick args: ${JSON.stringify(filePick)}`);
  }
  if (!dirPick || dirPick.args.defaultPath !== "/Users/tester/LocalPane") {
    throw new Error(`unexpected dir pick args: ${JSON.stringify(dirPick)}`);
  }
  if (calls.some((c) => c.command.startsWith("plugin:dialog|"))) {
    throw new Error(`sftpDownloadFile should not invoke plugin:dialog directly: ${JSON.stringify(calls)}`);
  }

  console.log("sftp-download-picker.test.js: passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
