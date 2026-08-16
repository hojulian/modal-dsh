# modal-dsh

A Modal sandbox bridge plus a DSH dynamic Cordis plugin that lets a DSH session
create and drive [Modal](https://modal.com) sandboxes — secure, isolated cloud
containers that boot in seconds.

Tools provided by the plugin:

- `modal_sandbox_create` — create a sandbox (image, dockerfile commands, main command, ports → HTTPS tunnels)
- `modal_sandbox_exec` / `modal_sandbox_exec_wait` — run a command, capture stdout/stderr tails, join later after a timeout
- `modal_sandbox_output` — read the retained main-process output tails
- `modal_sandbox_info` — status, tracked-sandbox list, tunnel URLs
- `modal_sandbox_terminate` — stop a sandbox (waits by default, returns exit code)
- `modal_sandbox_set_credentials` — persist Modal credentials (mode 600) and hot-apply them

## Layout

| File | Role |
| --- | --- |
| `plugin-host.js` | Source of record for the plugin (host half). Submitted **verbatim** via `cordis_define`. |
| `bridge.mjs` | Long-lived Node child process hosting the Modal JS SDK. NDI-JSON protocol over stdio. |
| `package.json`, `package-lock.json` | Bridge dependency (`modal ^0.9.0`). Keep in lockstep with `BRIDGE_PKG` in `plugin-host.js`. |

## Why a bridge

DSH Cordis plugins run in a restricted plain-JS `vm` realm — no `require`/`import`,
no `process`, no bundler — so the plugin cannot load the Modal SDK directly.
Instead it spawns `bridge.mjs` as a child process and speaks newline-delimited
JSON over its stdio.

On activation the plugin:

1. resolves the bridge dir `<workspaceRoot>/modal-dsh` (via the `sandboxPolicy`
   service; a hardcoded dev path is the last-resort fallback),
2. verifies `bridge.mjs` exists, rewrites `package.json` if it drifted, and runs
   `npm install` if `modal` is missing,
3. spawns the bridge, pings it, and pushes credentials via `configure`,
4. respawns the bridge automatically when it dies — sandboxes re-attach by ID
   (`client.sandboxes.fromId`), so cloud state is never lost to a bridge restart.

## Installing (DSH session)

1. Copy the contents of `plugin-host.js` **verbatim** into `cordis_define`
   (`code.host`, host-only plugin). It is the *body* of an async function —
   the top-level block must be preserved; the runner applies no transformation.
2. `cordis_run` the returned package.
3. If a tool reports missing Modal credentials, call
   `modal_sandbox_set_credentials` once.

## Credentials

Resolution order:

1. `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` in the host environment,
2. a DSH credential service entry named `modal` (format `"<token id> <token secret>"`),
3. `<bridgeDir>/credentials.json` (written by `modal_sandbox_set_credentials`, mode 600).

Token values are never written to logs or diagnostics.

## Bridge protocol (stdio)

```
request:  {"id": <n>, "method": "<name>", "params": {...}}
response: {"id": <n>, "ok": true,  "result": {...}}
          {"id": <n>, "ok": false, "error": {"message": "..."}}
```

Methods: `ping`, `status`, `configure`, `create`, `exec`, `execWait`, `output`,
`info`, `terminate`. Diagnostics go to stderr only.

Retained output tails: 256 KB per main-process stream, 1 MB per exec stream
(`totalBytes` always counts everything, `truncated` flags the cut).

## Known limitations

- The Modal SDK reports a process exit **before** its stdout/stderr streams
  deliver the final bytes. The bridge therefore drains both pumps (10 s cap)
  before returning final exec output; on a stuck stream the partial tail is
  returned instead of hanging.
- An exec record that timed out stays registered until `exec_wait` joins it,
  the sandbox is terminated, or the bridge restarts (by design, so it can be
  joined later; bounded, ~2 MB each).
- `ageMs` after a re-attach measures from attach time, not true sandbox age.
- `set_credentials` rebuilds the Modal client; streams of already-attached
  sandboxes may drop (newly created ones are unaffected).
- `create` may return `tunnels: {"error": ...}` if tunnels were not ready within
  60 s — re-fetch with `modal_sandbox_info`.
- Stopping the plugin kills the bridge, not the cloud sandboxes. Their lifetime
  is governed by Modal's `timeoutMs` / `idleTimeoutMs` (defaults 30 min / 10 min).
- Main-output `complete` flips only after the stream ends *and* a poll confirms
  the exit (consistent with the SDK's exit-before-drain behavior).

## Development

- Syntax: `node --check bridge.mjs`
- Plugin body precheck (exactly as the DSH runner does):
  `new vm.Script('(async () => {\n' + body + '\n})()')`
- Integrity: FNV-1a 32 over the file bytes. The plugin logs the on-disk bridge's
  `bytes=` / `fnv=` to `<bridgeDir>/bridge-diag.log` on every spawn, so a
  drifted file is visible in the diagnostics.
