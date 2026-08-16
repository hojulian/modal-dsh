# modal-dsh

[![CI](https://github.com/hojulian/modal-dsh/actions/workflows/ci.yml/badge.svg)](https://github.com/hojulian/modal-dsh/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](#english) · [中文](#中文)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that lets a DSH session drive [Modal](https://modal.com) Sandboxes — secure, isolated cloud containers that boot in seconds.

> Community plugin — **not** an official DeepSeek or Modal integration, not a security audit, not a production-readiness certificate.
> Tested with: `dsh` 0.1.0-rc.6 · Node 24 · pnpm 11 · `modal` JS SDK ^0.9.0

## Tools

| Tool | What it does |
| --- | --- |
| `modal_sandbox_create` | Create a sandbox (image, dockerfile commands, main command, ports → HTTPS tunnels) |
| `modal_sandbox_exec` | Run a command, capture stdout/stderr tails, return an `execId` if the wait elapses |
| `modal_sandbox_exec_wait` | Join a command that was still running |
| `modal_sandbox_output` | Read the retained main-process output tails |
| `modal_sandbox_info` | Status, tracked-sandbox list, tunnel URLs |
| `modal_sandbox_terminate` | Stop a sandbox (waits by default, returns the exit code) |
| `modal_sandbox_set_credentials` | Persist Modal credentials and hot-apply them |

## What's inside

```text
├── package.json              # dsh.bundle manifest + build scripts
├── cordis.patch.yml          # plugin row: id, package name, config
├── src/
│   ├── index.ts              # plugin entry: name / inject / Config / apply + runtime peer guard
│   ├── bridge-host.ts        # bridge child-process supervisor: bootstrap, credentials, NDJSON protocol
│   ├── tools.ts              # the seven modal_sandbox_* tool definitions
│   ├── services.ts           # structural types for the fs / subprocess / credentials host services
│   ├── bridge.mjs            # the Modal SDK host process (shipped verbatim as lib/bridge.mjs)
│   └── version.ts            # dependency-free caret-range matcher used by the runtime guard
├── tests/
│   ├── index.spec.ts         # registration, service guard (unit)
│   ├── bridge-host.spec.ts   # bootstrap, protocol, timeouts, credentials, tools (unit)
│   └── version.spec.ts       # prerelease range behavior matrix (unit)
├── scripts/
│   ├── copy-bridge.mjs       # ships src/bridge.mjs alongside the compiled output
│   ├── build-release-branch.mjs # assembles the scripts-free tree published to release + v* tag
│   ├── integration-test.mjs  # installs the PACKED tarball, registers the tools via apply(),
│   │                         # bootstraps the real bridge host, executes a real handler
│   └── dsh-smoke.sh          # fresh DSH profile install + config check + web boot (bounded retry)
├── .github/workflows/ci.yml  # doctor → typecheck → build → unit tests → pack → integration → DSH boot → release (manual)
└── README.md                 # bilingual
```

## Why a bridge process

The Modal JavaScript SDK cannot be loaded into the plugin's execution environment, so the plugin ships `bridge.mjs`: a long-lived Node child process that owns one `ModalClient`, an in-memory sandbox registry, and bounded output tails. Plugin and bridge speak newline-delimited JSON over stdio:

```text
request:  {"id": <n>, "method": "<name>", "params": {...}}
response: {"id": <n>, "ok": true,  "result": {...}}
          {"id": <n>, "ok": false, "error": {"message": "..."}}
```

Methods: `ping`, `status`, `configure`, `create`, `exec`, `execWait`, `output`, `info`, `terminate`. Diagnostics go to stderr only.

On activation the plugin:

1. resolves the bridge dir `<workspaceRoot>/modal-dsh` (via the `sandboxPolicy` service, or the `bridgeRoot` config),
2. writes the **packaged** `lib/bridge.mjs` and its manifest there, and runs `npm install` once if the Modal SDK is missing,
3. spawns the bridge, pings it, and pushes credentials via `configure`,
4. respawns the bridge on the next tool call if it died — sandboxes re-attach by ID (`client.sandboxes.fromId`), so cloud state survives a bridge restart.

## Install

Latest release:

```sh
dsh plugin --profile web add github:hojulian/modal-dsh
dsh web --port 4099
```

Pinned to a version:

```sh
dsh plugin --profile web add "github:hojulian/modal-dsh#semver:0.1.0"
```

`#semver:` takes any range — `^0.1.0`, `~0.1.0`, or an exact `0.1.0` — resolved
against the repo's release tags.

Both forms install a **prebuilt** tree: `lib/` already compiled, `package.json`
with no lifecycle scripts, so nothing is built inside your DSH profile. The
ref-less form works because `release` is the repository's default branch; the
`v*` tags are what `#semver:` matches.

> Installing from the `main` branch will not work. It is TypeScript source, and
> its `prepare` script would have to build in your profile — which pnpm refuses
> to do for git-hosted packages (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`).

### From source

```sh
git clone https://github.com/hojulian/modal-dsh.git
cd modal-dsh
pnpm install
pnpm test
pnpm pack
dsh plugin --profile web add ./modal-dsh-0.1.0.tgz
dsh web --port 4099
```

Then ask your agent: "Create a Modal sandbox and run `python3 -V` in it."

## Configuration

`cordis.patch.yml` inserts the plugin row; every field has a default:

| Field | Default | Meaning |
| --- | --- | --- |
| `bridgeRoot` | `''` | Directory the bridge is materialized under. Empty = the `sandboxPolicy` workspace root. |
| `appName` | `modal-dsh-sandboxes` | Modal app the sandboxes are created under. |
| `defaultImage` | `python:3.13` | Image used when a `create` call omits one. |

Required services in the composition: `tools`, `fs`, `subprocess` (the plugin refuses to load without the last two). `credentials`, `timer`, and `sandboxPolicy` are used when present.

## Credentials

Resolution order:

1. `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` in the host environment,
2. a DSH credential service entry named `modal` (format `"<token id> <token secret>"`),
3. `<bridgeDir>/credentials.json`, written by `modal_sandbox_set_credentials`.

Token values are never logged and never appear in the tool's presented call card.

## Dependency strategy (read this)

- **Tested with**: `@deepseek-ai/dsh-tools` **0.1.0-rc.6** and `@deepseek-ai/cordis` **^4.0.1**.
- `peerDependencies` declares `"@deepseek-ai/dsh-tools": "^0.1.0-rc.6"` — a **caret range, not a pin**. It matches `0.1.0-rc.6`, later `0.1.x` RCs, and `0.1.0` stable; it does not match `0.1.0-rc.5` or older.
- `devDependencies` uses the same range; the committed `pnpm-lock.yaml` pins the exact tested version for development and CI.
- pnpm (default config) can link an **older** RC into the plugin's peer slot with only a warning. Because that silent case is the dangerous one, `apply()` runs a runtime guard (`src/version.ts`) and **refuses to load** when the resolved `@deepseek-ai/dsh-tools` does not satisfy `^0.1.0-rc.6`.

## CI

`.github/workflows/ci.yml` runs:

1. `doctor` — [dsh-plugin-doctor-action](https://github.com/zoahdev/dsh-plugin-doctor-action) on the manifest and bundle
2. `test-and-load` (ubuntu) — `pnpm install --frozen-lockfile` → `pnpm typecheck` → `node --check src/bridge.mjs` → `pnpm run build` → `pnpm test` → `pnpm pack` → **packaged integration**: `scripts/integration-test.mjs` installs the actual tarball into a fresh project, registers all seven tools through the real `apply()` / `ctx.tools.register` path, runs the real bridge bootstrap (asserting the packaged bridge source is written out and handshaked), executes a real handler over the real protocol, and asserts the rendered result — plus a second scenario asserting the peer guard rejects `0.1.0-rc.3`
3. `dsh-smoke` (**windows-latest**) — fresh `DSH_HOME`, plugin row in `--dump-config`, `dsh web` boot with a 30 s bounded retry
4. `publish-release` (manual `workflow_dispatch` on `main`, after all three pass) — reads the version from `package.json` and refuses to proceed if `v<version>` already exists, then `scripts/build-release-branch.mjs` packs the build and strips `scripts`/`devDependencies` from the packed `package.json`. The result is committed onto the `release` branch and tagged `v<version>`

### Branch layout

| Ref | Contents | Role |
| --- | --- | --- |
| `main` | TypeScript source | Development. Not installable. |
| `release` | Prebuilt, no lifecycle scripts | **Repository default branch**, so a ref-less `github:hojulian/modal-dsh` resolves here. One commit per release. |
| `v<version>` | Snapshot of a `release` commit | What `#semver:` ranges match. Immutable. |

To cut a release: bump `version` in `package.json` on `main`, then run the `ci` workflow manually from the Actions tab.

Two things follow from how git installs resolve, and are easy to break by hand:

- **CI creates the tag, not you.** `#semver:` checks out the matched tag's tree, so the tag has to sit on the built commit. A `v*` tag pushed onto a `main` commit would resolve to the source tree — precisely what consumers cannot install.
- **`release` is never force-pushed.** It is a default branch and a tag target; rewriting it would break clones and orphan released tags for garbage collection.

> Upstream note: `dsh web` (0.1.0-rc.6 npm CLI) currently fails to boot on GitHub Actions ubuntu-latest because the `@deepseek-ai/dsh-subprocess-local` native `pty.node` linux-x64 prebuild is missing from the published package, so the boot smoke runs on Windows. Tracked upstream in [discussion #1686](https://github.com/deepseek-ai/deepseek-harness/discussions/1686).

Run the health checker locally with the same checks:

```sh
pnpm dlx @deepseek-ai/dsh --version   # must print 0.1.0-rc.6 or later
```

## Known limitations

- The Modal SDK reports a process exit **before** its stdout/stderr streams deliver the final bytes. The bridge drains both pumps (10 s cap) before returning final exec output; on a stuck stream the partial tail is returned instead of hanging.
- An exec record that timed out stays registered until `exec_wait` joins it, the sandbox is terminated, or the bridge restarts (by design; bounded, ~2 MB each).
- Retained tails: 256 KB per main-process stream, 1 MB per exec stream. `totalBytes` always counts everything, `truncated` flags the cut.
- `ageMs` after a re-attach measures from attach time, not true sandbox age.
- `set_credentials` rebuilds the Modal client; streams of already-attached sandboxes may drop (newly created ones are unaffected).
- `create` may return `tunnels: {"error": ...}` if tunnels were not ready within 60 s — re-fetch with `modal_sandbox_info`.
- Stopping the plugin kills the bridge, not the cloud sandboxes. Their lifetime is governed by Modal's `timeoutMs` / `idleTimeoutMs` (defaults 30 min / 10 min).
- Cancelling a tool call stops the plugin waiting; it does not cancel work already started inside the sandbox.

## Troubleshooting

### npm: `ERESOLVE` peer dependency conflict

The host already has an RC that does not satisfy `^0.1.0-rc.6`. Upgrade the host, then reinstall the plugin:

```sh
pnpm dlx @deepseek-ai/dsh plugin --profile web add ./modal-dsh-0.1.0.tgz
```

Do **not** reach for `--legacy-peer-deps` — the runtime guard refuses to load an incompatible link anyway.

### The tools report that Modal credentials are not configured

Call `modal_sandbox_set_credentials` once with your Modal token ID and secret, or set `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` in the host environment before starting DSH.

### `npm install of the modal SDK failed`

The bridge dir needs network access and a working `npm` on `PATH` for its one-time SDK install. Check `<workspaceRoot>/modal-dsh` is writable by the session.

## License

MIT © 2026 Julian Ho

---

## 中文

**modal-dsh** 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，让 DSH 会话可以创建并驱动 [Modal](https://modal.com) Sandbox——秒级启动的隔离云容器。

> 社区插件——**非** DeepSeek / Modal 官方集成，不代表安全审计或生产就绪认证。
> 已验证版本：`dsh` 0.1.0-rc.6 · Node 24 · pnpm 11 · `modal` JS SDK ^0.9.0

## 工具

`modal_sandbox_create`（创建沙箱、暴露端口→HTTPS 隧道）、`modal_sandbox_exec` / `modal_sandbox_exec_wait`（执行命令、超时后再 join）、`modal_sandbox_output`（读取主进程输出尾部）、`modal_sandbox_info`（状态、列表、隧道 URL）、`modal_sandbox_terminate`（终止沙箱）、`modal_sandbox_set_credentials`（写入并热更新凭据）。

## 为什么需要 bridge 进程

Modal 的 JS SDK 无法加载进插件的执行环境，因此插件随包附带 `bridge.mjs`：一个常驻 Node 子进程，持有唯一的 `ModalClient`、沙箱注册表与有界输出缓冲，双方以 stdio 上的 NDJSON 通信。激活时插件把**打包内的** `lib/bridge.mjs` 写入 `<workspaceRoot>/modal-dsh`，必要时执行一次 `npm install`，随后 spawn、ping、`configure`。bridge 挂掉会在下次工具调用时重启——沙箱按 ID 重新 attach，云端状态不会丢失。

## 使用

安装最新发布：

```sh
dsh plugin --profile web add github:hojulian/modal-dsh
dsh web --port 4099
```

固定到某个版本：

```sh
dsh plugin --profile web add "github:hojulian/modal-dsh#semver:0.1.0"
```

`#semver:` 接受任意范围（`^0.1.0`、`~0.1.0` 或精确的 `0.1.0`），在仓库的发布 tag 中解析。

两种写法安装的都是**预编译**产物：`lib/` 已编译好，`package.json` 不含任何生命周期
脚本，你的 DSH profile 不需要执行构建。不带 ref 的写法之所以可用，是因为 `release`
是仓库的默认分支；`#semver:` 匹配的则是 `v*` tag。

> 从 `main` 分支安装不会成功：`main` 只有 TypeScript 源码，其 `prepare` 脚本需要在你的
> profile 里执行构建，而 pnpm 会拒绝 git 依赖执行构建脚本
> （`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）。

### 从源码构建

```sh
git clone https://github.com/hojulian/modal-dsh.git
cd modal-dsh
pnpm install
pnpm test
pnpm pack
dsh plugin --profile web add ./modal-dsh-0.1.0.tgz
dsh web --port 4099
```

然后让 agent："Create a Modal sandbox and run `python3 -V` in it."

## 配置

`bridgeRoot`（默认空 = `sandboxPolicy` 的 workspace root）、`appName`（默认 `modal-dsh-sandboxes`）、`defaultImage`（默认 `python:3.13`）。composition 必须挂载 `tools` / `fs` / `subprocess`；`credentials`、`timer`、`sandboxPolicy` 存在时会被使用。

## 凭据

解析顺序：宿主环境的 `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` → DSH 凭据服务中名为 `modal` 的条目（格式 `"<token id> <token secret>"`）→ `<bridgeDir>/credentials.json`。Token 不会写入日志，也不会出现在工具调用卡片里。

## 依赖策略

`peerDependencies` 声明 `"@deepseek-ai/dsh-tools": "^0.1.0-rc.6"`（caret 范围，不是 pin）。pnpm 默认配置可能把更旧的 RC 静默链进 peer 槽，因此 `apply()` 内置运行时守卫：解析到的版本不满足该范围时直接拒绝加载。

## CI

`doctor`（插件体检 action）→ `test-and-load`（typecheck、`node --check src/bridge.mjs`、build、单测、pack、打包产物集成与真实工具调用、peer 守卫场景）→ `dsh-smoke`（windows-latest：全新 `DSH_HOME` 安装、`--dump-config` 校验、`dsh web` 限时启动）。

## 已知限制

见上方英文 [Known limitations](#known-limitations)：SDK 先报退出码后才 flush 输出（bridge 有 10 秒 drain 上限）、超时的 exec 记录会保留待 join、输出尾部上限 256KB / 1MB、re-attach 后的 `ageMs` 从 attach 起算、`set_credentials` 会重建客户端、隧道未就绪时 `create` 返回 `tunnels.error`、停用插件只杀 bridge 不杀云端沙箱、取消工具调用不会取消沙箱内已启动的工作。

## 许可证

MIT © 2026 Julian Ho
