# Manual desktop SFTP reliability test playbook (M9)

This playbook verifies the desktop SFTP browser and transfer subsystem:
connection pooling, queued transfers, structured errors, per-transfer
cancel/retry, panel-channel refresh, and non-invasive CWD follow.

The sync backend has its own wire-level playbook in
`docs/manual-sftp-test.md`. This document is for the desktop files UI.

## Prerequisites

- A desktop ZeroTerm build from the current branch.
- One SSH host reachable from the test machine.
- One writable remote scratch directory, for example:
  `/home/<user>/zeroterm-sftp-test/`.
- Optional but recommended:
  - A second remote host for remote-to-remote copy checks.
  - A shell that emits OSC 7 (`iTerm2`, `GNOME Terminal`, modern `vte`,
    or a zsh/bash prompt configured to emit OSC 7).
- Local test data:
  - One large file, at least 500 MB.
  - One mixed directory tree with:
    - 200+ small files
    - nested directories
    - one unreadable file, if easy to prepare
    - one symlink, if the remote host allows it

## Test 1 - Open, list, and basic navigation

1. Open the SFTP workspace and connect a pane to the test host.
2. Browse into the scratch directory and confirm listing succeeds.
3. Rapidly click through several directories in succession.
4. Confirm the final pane contents always match the last clicked path.

Expected:
- No stale list result overwrites the final navigation target.
- No reconnect prompt is needed for normal navigation.

## Test 2 - Single-file upload and download

1. Upload a normal local file into the scratch directory.
2. Download it back to a new local path.
3. Rename it remotely, then delete it remotely.

Expected:
- Upload/download progress appears in the transfer dock.
- Completion status is correct.
- Rename/delete succeed without raw error strings leaking to the UI.

## Test 3 - Queued transfers and independent cancel

1. Start at least 4 transfers quickly:
   - two uploads
   - one download
   - one pane-to-pane copy, if available
2. Confirm only a bounded number run at once and the rest stay queued.
3. Cancel one running transfer from the dock.
4. Cancel one queued transfer from the dock.

Expected:
- The dock shows one row per transfer.
- Status transitions include `Queued`, `Running`, `Cancelled`, `Done`, `Failed`.
- Cancelling one item does not affect the others.

## Test 4 - Failure row and retry button

1. Trigger one deterministic failure, for example:
   - download to an existing local path without overwrite
   - upload to a remote path that already exists, if the flow reaches the conflict path
   - disconnect the network during a transfer
2. Confirm the failed transfer row stays visible.
3. Click `Retry`.

Expected:
- The failed row shows a structured human message, not raw JSON.
- `Retry` starts a fresh transfer.
- The new transfer can complete without reloading the workspace.

## Test 5 - Large drag-drop upload

1. Drag a large file from the OS into the remote pane.
2. If possible, also drag a directory containing mixed-size files.

Expected:
- The UI remains responsive.
- Memory use should not spike as if the whole file were serialized through JSON IPC.
- The transfer appears as normal queued/running work in the dock.

## Test 6 - Directory upload with partial failures

1. Upload the prepared mixed directory tree.
2. Include at least one item that should fail:
   - unreadable file
   - symlink
3. Let the transfer finish.

Expected:
- The whole tree does not abort on the first non-fatal file error.
- Successful files still arrive.
- Final status summarizes skipped items.
- The summary message is human-readable and does not expose serialized error payloads.

## Test 7 - Remote-to-local directory download with reconnect

1. Start downloading a large remote directory tree.
2. During transfer, sever the SSH connection once:
   - restart `sshd`, or
   - temporarily block the network path, or
   - force-close the server-side session if safe in the test environment
3. Let the transfer continue or fail naturally.

Expected:
- The current file is retried once on a fresh SFTP channel.
- If retry succeeds, the transfer continues.
- If retry still fails, the transfer fails cleanly instead of hanging forever.

## Test 8 - Local-to-remote upload with reconnect

1. Start uploading the large local file.
2. Break the SSH connection once mid-transfer.

Expected:
- ZeroTerm retries the current file once on a fresh channel.
- The transfer either recovers or fails cleanly with a structured error.
- No permanent "stalled" state remains in the dock.

## Test 9 - Remote-to-remote copy with reconnect

1. Use two remote panes, or one remote host copying within itself.
2. Start a large remote-to-remote copy.
3. Break the source or destination connection once mid-transfer.

Expected:
- The current file is retried once with fresh pooled channels.
- Progress does not permanently over-count bytes after retry.

## Test 10 - Panel command recovery

1. Keep a remote pane open.
2. Break the underlying SSH/SFTP connection while the pane remains visible.
3. Without manually reconnecting, try:
   - list a directory
   - create a directory
   - rename an entry
   - delete an entry
   - open a small text file
   - save a small text file

Expected:
- The backend refreshes the panel channel transparently when possible.
- The command succeeds after one retry, or fails cleanly with a structured error.
- The user should not need to disconnect and reopen the pane for ordinary recovery.

## Test 11 - OSC 7 CWD follow

1. Open a terminal session for the same host and the terminal-side SFTP pane.
2. In a shell that emits OSC 7, run `cd` across several directories.
3. In a shell without OSC 7, repeat the same actions if you can test both.

Expected:
- With OSC 7, the SFTP pane follows directory changes promptly.
- Without OSC 7, the pane stays where it is without errors.
- No dotfiles are modified on the remote host.
- No polling helper installation prompt appears.

## Test 12 - Regression sweep

Run a final short pass for:

- Open/close SFTP pane repeatedly for the same host.
- Transfer multiple files to the same host without connection storms.
- Drag between local and remote panes.
- Drag between two remote panes.
- Overwrite confirmation still behaves correctly.

Expected:
- No obvious MaxStartups-style reconnect burst.
- No frozen dock rows after completion.
- No raw `"destination already exists"` string matching is visible in the UI logic.

## Cleanup

- Remove the scratch directory contents from the remote host(s).
- Remove any temporary local download targets.

## Notes to record

For each failed step, capture:

- host OS and shell
- whether OSC 7 was enabled
- whether the failing operation used panel browse, drag-drop, or pane-to-pane copy
- the exact UI message shown
- whether retry recovered automatically or required manual reconnect
