// Dev source of record for the "Modal Sandbox" dynamic Cordis Plugin (host half).
// This exact text is submitted VERBATIM via cordis_define (no substitution).
// Runs as the BODY of an async function inside the DSH vm sandbox: `harness`,
// `console`, `atob`, `btoa`, TextEncoder/Decoder are globals; `ctx` is only
// available inside apply(ctx). The body must return the plugin object.

{
  // The bridge source is NOT embedded: it is read from disk at apply time.
  // <bridgeDir>/bridge.mjs (maintained by the session dev workflow, smoke-tested
  // before each define) is the single source of truth.
  const BRIDGE_PKG = JSON.stringify({
    name: 'dsh-modal-sandbox-bridge',
    private: true,
    version: '0.1.0',
    type: 'module',
    description: 'Long-lived bridge process hosting the Modal JS SDK for the DSH Modal Sandbox plugin.',
    dependencies: { modal: '^0.9.0' }
  });

  const FALLBACK_BRIDGE_ROOT = '/opt/dsh/workspace/dhs';

  return {
    name: 'modal-sandbox',
    apply(ctx) {
      const fs = ctx.get('fs');
      const subprocess = ctx.get('subprocess');
      const credentialsSvc = ctx.get('credentials');
      const timer = ctx.get('timer');
      const policy = ctx.get('sandboxPolicy');
      if (!fs || !subprocess) throw new Error('modal-sandbox needs the "fs" and "subprocess" services mounted in the composition');

      const bridgeDir = ((policy && policy.workspaceRoot) || FALLBACK_BRIDGE_ROOT) + '/modal-sandbox';
      const bridgePath = bridgeDir + '/bridge.mjs';

      let bridge = null;
      let spawnInFlight = null; // in-flight spawn; guards bootstrap vs. first tool call
      let creds = null; // {tokenId, tokenSecret} resolved at apply / refreshed by set_credentials
      let bridgeSourceInfo = null; // { bytes, fnv } of the on-disk bridge source

      function fnv1a(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
          h ^= str.charCodeAt(i);
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(16);
      }

      // ---- diagnostics (console + on-disk log; read from shell while debugging) ----
      const DIAG_PATH = bridgeDir + '/bridge-diag.log';
      const diagT0 = Date.now();
      const diagLines = [];
      let diagSeq = 0;
      async function diag(msg) {
        const line = '[t+' + (Date.now() - diagT0) + 'ms #' + (++diagSeq) + '] ' + msg;
        diagLines.push(line);
        if (diagLines.length > 100) diagLines.splice(0, diagLines.length - 100);
        try { console.error('modal-sandbox: [diag] ' + line); } catch (e) {}
        try {
          const t = await fs.resolve(DIAG_PATH);
          await fs.writeText(t, diagLines.join('\n') + '\n');
        } catch (e) {}
      }

      // ---- bootstrap -----------------------------------------------------------

      async function ensureBridgeFiles() {
        // The fs service is target-based: operations take an FsTarget from resolve().
        // writeText creates missing parent directories, so no explicit mkdir is needed.
        // The bridge source itself is read from disk (see header); a missing file
        // is a clear error rather than a silent rewrite.
        const bridgeTarget = await fs.resolve(bridgePath);
        const bridgeSrc = await fs.readText(bridgeTarget).catch(() => null);
        if (bridgeSrc === null) throw new Error('bridge source missing at ' + bridgePath + ' (restore the dev file, then retry a tool call)');
        bridgeSourceInfo = { bytes: bridgeSrc.length, fnv: fnv1a(bridgeSrc) };
        void diag('bridge source from disk: bytes=' + bridgeSourceInfo.bytes + ' fnv=' + bridgeSourceInfo.fnv);
        const pkgTarget = await fs.resolve(bridgeDir + '/package.json');
        const pkgExisting = await fs.readText(pkgTarget).catch(() => null);
        if (pkgExisting !== BRIDGE_PKG) await fs.writeText(pkgTarget, BRIDGE_PKG);
        const modalPkgTarget = await fs.resolve(bridgeDir + '/node_modules/modal/package.json');
        if (!(await fs.stat(modalPkgTarget))) {
          const node = await subprocess.resolveExecutable('node');
          const npm = await subprocess.resolveExecutable('npm');
          const h = subprocess.spawn({
            argv: [npm, 'install', '--no-audit', '--no-fund'],
            cwd: bridgeDir,
            stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
            graceMs: 5000
          });
          const out = await h.done;
          if (out.exitCode !== 0) {
            const errText = h.collected.stderr && h.collected.stderr.readFrom(0).text ? h.collected.stderr.readFrom(0).text : '';
            throw new Error('npm install of the modal SDK failed (exit ' + out.exitCode + '): ' + errText.slice(-2000));
          }
        }
      }

      function probeEnvCreds() {
        const code = 'const t=process.env.MODAL_TOKEN_ID||"";const s=process.env.MODAL_TOKEN_SECRET||"";console.log(JSON.stringify({t:t,s:s}))';
        return subprocess.resolveExecutable('node').then((node) => {
          const h = subprocess.spawn({
            argv: [node, '-e', code],
            cwd: '/',
            stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
            graceMs: 2000
          });
          return h.done.then((out) => {
            if (out.exitCode !== 0) return null;
            try {
              const p = JSON.parse(h.collected.stdout.readFrom(0).text.trim());
              return p.t && p.s ? { tokenId: p.t, tokenSecret: p.s } : null;
            } catch (e) {
              return null;
            }
          });
        }).catch(() => null);
      }

      function readServiceCreds() {
        if (!credentialsSvc) return Promise.resolve(null);
        return credentialsSvc.describe('modal').then((info) => {
          if (!info || info.available === false) return null;
          return credentialsSvc.resolve('modal');
        }).then((res) => {
          if (!res || !res.value) return null;
          const parts = String(res.value).trim().split(/\s+/);
          if (parts.length === 2) return { tokenId: parts[0], tokenSecret: parts[1] };
          throw new Error("the 'modal' credential should be '<token id> <token secret>'");
        }).catch((e) => {
          console.error('modal-sandbox: credential service lookup failed: ' + (e && e.message ? e.message : e));
          return null;
        });
      }

      function readFileCreds() {
        return fs.resolve(bridgeDir + '/credentials.json').then((t) => fs.readText(t)).then((text) => {
          const p = JSON.parse(text);
          return p && p.tokenId && p.tokenSecret ? { tokenId: String(p.tokenId), tokenSecret: String(p.tokenSecret) } : null;
        }).catch(() => null);
      }

      // ---- bridge plumbing -----------------------------------------------------

      function failPending(b, err) {
        const p = b ? b.pending : new Map();
        if (b) b.pending = new Map();
        for (const entry of p.entries()) {
          const w = entry[1];
          if (w.timer) { try { w.timer(); } catch (e) {} }
          w.reject(err);
        }
      }

      function bridgeRawCall(method, params, timeoutMs) {
        const b = bridge;
        const id = ++b.seq;
        return new Promise((resolve, reject) => {
          const w = { resolve: resolve, reject: reject, timer: null };
          b.pending.set(id, w);
          if (timer && timeoutMs) {
            w.timer = timer.timeout(() => {
              if (b.pending.delete(id)) {
                w.timer = null;
                reject(new Error('bridge call ' + method + ' timed out after ' + timeoutMs + 'ms'));
              }
            }, timeoutMs);
          }
          try {
            b.handle.stdin.write(JSON.stringify({ id: id, method: method, params: params || {} }) + '\n');
            void diag('bridge call ' + method + ' (id ' + id + ') written, pid=' + (b.handle.pid));
          } catch (e) {
            void diag('bridge call ' + method + ' (id ' + id + ') write failed: ' + (e && e.message));
            if (b.pending.delete(id)) {
              if (w.timer) { try { w.timer(); } catch (e2) {} }
              reject(e);
            }
          }
        });
      }

      function spawnBridge() {
        return subprocess.resolveExecutable('node').then((node) => {
          const env = {};
          if (creds) {
            env.MODAL_TOKEN_ID = creds.tokenId;
            env.MODAL_TOKEN_SECRET = creds.tokenSecret;
          }
          const spec = {
            argv: [node, bridgePath],
            cwd: bridgeDir,
            stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 } },
            graceMs: 5000
          };
          if (Object.keys(env).length > 0) spec.env = env;
          const h = subprocess.spawn(spec);
          const b = { handle: h, pending: new Map(), seq: 0, dead: false, starting: null, startedAt: Date.now(), pinged: false };
          bridge = b;
          void diag('spawn: node=' + node + ' bridge=' + bridgePath + ' pid=' + h.pid + ' envCreds=' + (Object.keys(env).length > 0));
          let buf = '';
          try { h.stdout.setEncoding('utf8'); } catch (e) {}
          try { h.stdin.on('error', (e) => { void diag('bridge ' + h.pid + ' stdin stream error: ' + (e && e.message)); }); } catch (e) {}
          try { h.stdout.on('error', (e) => { void diag('bridge ' + h.pid + ' stdout stream error: ' + (e && e.message)); }); } catch (e) {}
          h.stdout.on('data', (chunk) => {
            if (b !== bridge || b.dead) return;
            buf += String(chunk);
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i).trim();
              buf = buf.slice(i + 1);
              if (!line) continue;
              let resp;
              try { resp = JSON.parse(line); } catch (e) { void diag('bridge ' + h.pid + ' unparseable line: ' + line.slice(0, 200)); continue; }
              void diag('bridge ' + h.pid + ' response id=' + resp.id + ' ok=' + resp.ok + (resp.error ? ' err=' + resp.error.message : ''));
              const w = b.pending.get(resp.id);
              if (!w) continue;
              b.pending.delete(resp.id);
              if (w.timer) { try { w.timer(); } catch (e) {} }
              if (resp.ok) w.resolve(resp.result === undefined ? null : resp.result);
              else w.reject(new Error((resp.error && resp.error.message) || 'modal bridge error'));
            }
          });
          h.stdout.on('close', () => {
            const c = h.collected || {};
            let errText = '(stderr not collected)';
            try { errText = c.stderr && c.stderr.readFrom ? c.stderr.readFrom(0).text : errText; } catch (e) {}
            void diag('bridge ' + h.pid + ' stdout CLOSED after ' + (Date.now() - b.startedAt) + 'ms; collected stderr: ' + (errText || '(empty)'));
            if (b === bridge && !b.dead) {
              b.dead = true;
              failPending(b, new Error('modal bridge exited unexpectedly (pid ' + h.pid + ')'));
            }
          });
          h.done.then((out) => {
            void diag('bridge ' + h.pid + ' done: exit=' + out.exitCode + ' signal=' + out.signal + ' after ' + (Date.now() - b.startedAt) + 'ms');
            if (b === bridge && !b.dead) {
              b.dead = true;
              failPending(b, new Error('modal bridge exited unexpectedly (exit ' + out.exitCode + ' signal ' + out.signal + ')'));
            }
          }).catch((e) => { void diag('bridge ' + h.pid + ' done rejected: ' + (e && e.message)); });
          try {
            void h.waitForExit().then(() => {
              void diag('bridge ' + h.pid + ' tree exit confirmed via waitForExit at t+' + (Date.now() - b.startedAt) + 'ms');
            }).catch((e) => { void diag('bridge ' + h.pid + ' waitForExit error: ' + (e && e.message)); });
          } catch (e) { void diag('bridge ' + h.pid + ' waitForExit threw: ' + (e && e.message)); }
          b.starting = bridgeRawCall('ping', {}, 30000).then((pong) => {
            b.pinged = true;
            void diag('bridge ' + h.pid + ' ping ok: ' + JSON.stringify(pong));
            if (creds) return bridgeRawCall('configure', creds, 15000).then((r) => { void diag('bridge ' + h.pid + ' configure ok'); return r; });
            return pong;
          }).catch((e) => {
            void diag('bridge ' + h.pid + ' starting failed: ' + (e && e.message) + ' (pinged=' + b.pinged + ')');
            b.dead = true;
            throw e;
          });
          void diag('bridge started (pid ' + h.pid + ', creds ' + (creds ? 'explicit' : 'ambient/fallback') + ')');
          return b;
        });
      }

      async function ensureBridge() {
        if (spawnInFlight) await spawnInFlight; // a concurrent spawn (e.g. bootstrap) owns the race
        if (!bridge || bridge.dead) {
          spawnInFlight = ensureBridgeFiles()
            .then(() => spawnBridge())
            .catch((e) => { spawnInFlight = null; throw e; });
          await spawnInFlight;
          spawnInFlight = null;
        }
        await bridge.starting;
        return bridge;
      }

      const CRED_HINT = 'Modal credentials are not configured. Provide them with modal_sandbox_set_credentials, set MODAL_TOKEN_ID/MODAL_TOKEN_SECRET in the host environment, or store a DSH credential named "modal" as "<token id> <token secret>".';

      function call(method, params, timeoutMs) {
        return ensureBridge().then(() => bridgeRawCall(method, params, timeoutMs)).catch((e) => {
          const msg = e && e.message ? e.message : String(e);
          if (/unauthenticated|unauthorized|token_id or token_secret|modalclient constructor/i.test(msg)) {
            throw new Error(msg + ' ' + CRED_HINT);
          }
          throw e;
        });
      }

      // ---- tools ---------------------------------------------------------------

      const textRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];

      const toolDisposers = [];

      function defTool(tool) {
        const def = harness.defineTool(tool);
        toolDisposers.push(harness.registerTool(ctx, def));
        return def;
      }

      defTool({
        name: 'modal_sandbox_create',
        description: 'Create a Modal Sandbox: a secure, isolated cloud container that boots in seconds. The sandbox keeps running in the cloud after this call returns (it is not local). Omit command to keep it idle; pass command to start a long-running main process (e.g. a web server). Pass encryptedPorts to expose container ports as public HTTPS tunnel URLs. Use the returned sandboxId with modal_sandbox_exec / modal_sandbox_output / modal_sandbox_info / modal_sandbox_terminate.',
        parameters: {
          image: { type: 'string', description: 'Container image reference, e.g. "python:3.13" or "node:24". Defaults to python:3.13.' },
          dockerfileCommands: { type: 'array', items: { type: 'string' }, description: 'Optional Dockerfile-style commands applied on top of the image, e.g. ["RUN apt-get update && apt-get install -y curl git"]' },
          command: { type: 'array', items: { type: 'string' }, description: 'Main process argv, e.g. ["bash","-lc","python3 -m http.server 8000"]. Omit to keep the sandbox idle.' },
          env: { type: 'json', description: 'Environment variables as an object, e.g. {"PORT": "8000"}' },
          workdir: { type: 'string', description: 'Working directory inside the sandbox.' },
          cpu: { type: 'number', description: 'Reserved CPU cores (fractional allowed).' },
          memoryMiB: { type: 'number', description: 'Reserved memory in MiB.' },
          timeoutMs: { type: 'number', description: 'Maximum sandbox lifetime in ms. Defaults to 30 minutes.' },
          idleTimeoutMs: { type: 'number', description: 'Idle lifetime in ms before Modal terminates the sandbox. Defaults to 10 minutes.' },
          encryptedPorts: { type: 'array', items: { type: 'number' }, description: 'Container ports to expose via HTTPS tunnels.' },
          unencryptedPorts: { type: 'array', items: { type: 'number' }, description: 'Container ports to expose via plain tunnels.' },
          blockNetwork: { type: 'boolean', description: 'Block all outbound network from the sandbox.' }
        },
        execute: (args) => call('create', args, 240000),
        output: {
          schema: { type: 'json', description: 'JSON result: the created sandbox, at least { sandboxId } plus any returned descriptor fields.' },
          render: textRender
        }
      });

      defTool({
        name: 'modal_sandbox_exec',
        description: 'Run a command inside a Modal Sandbox and wait up to timeoutMs (default 120s) for it to finish. Returns the exit code plus captured stdout/stderr. If the command is still running when the wait elapses it keeps running in the sandbox and the result has running=true with an execId: call modal_sandbox_exec_wait with that execId to join it later. sandboxId may be any sandbox created by modal_sandbox_create (or previously attached); unknown IDs are re-attached by ID.',
        parameters: {
          sandboxId: { type: 'string', required: true, description: 'Target sandbox ID.' },
          command: { type: 'array', items: { type: 'string' }, required: true, description: 'argv to run, e.g. ["bash","-lc","echo hello && python3 -V"]' },
          workdir: { type: 'string', description: 'Working directory for the command.' },
          env: { type: 'json', description: 'Extra environment variables for the command.' },
          stdin: { type: 'string', description: 'Optional text written to the process stdin, followed by EOF.' },
          timeoutMs: { type: 'number', description: 'Maximum wait in ms (1..900000, default 120000). A timeout is NOT a failure.' }
        },
        execute: (args) => call('exec', args, Math.min(Math.max(Number(args.timeoutMs) || 120000, 1), 900000) + 60000),
        output: {
          schema: { type: 'json', description: 'JSON result: exec outcome — { exitCode, stdout, stderr } and, when the wait elapsed, { running: true, execId }.' },
          render: textRender
        }
      });

      defTool({
        name: 'modal_sandbox_exec_wait',
        description: 'Join a command that modal_sandbox_exec reported as still running (running=true). Returns the exit code and the full captured stdout/stderr once the command finishes, or running=true again if it is still going after timeoutMs.',
        parameters: {
          sandboxId: { type: 'string', required: true, description: 'Sandbox ID the execId belongs to.' },
          execId: { type: 'string', required: true, description: 'execId returned by modal_sandbox_exec.' },
          timeoutMs: { type: 'number', description: 'Maximum wait in ms (1..900000, default 120000).' }
        },
        execute: (args) => call('execWait', args, Math.min(Math.max(Number(args.timeoutMs) || 120000, 1), 900000) + 30000),
        output: {
          schema: { type: 'json', description: 'JSON result: { exitCode, running, stdout, stderr, truncated }, or { error } when the exec itself failed.' },
          render: textRender
        }
      });

      defTool({
        name: 'modal_sandbox_output',
        description: 'Read the buffered main-process output of a Modal Sandbox (the process started by the sandbox command, not an exec). Returns up to the retained tail (256KB) per stream with totalBytes and a truncated flag, plus complete=true once the main process has exited.',
        parameters: {
          sandboxId: { type: 'string', required: true, description: 'Target sandbox ID.' },
          stream: { type: 'string', enum: ['stdout', 'stderr', 'both'], description: 'Which stream to read. Defaults to both.' }
        },
        execute: (args) => call('output', args, 30000),
        output: {
          schema: { type: 'json', description: 'JSON result: for "both", { stdout, stderr } each { text, totalBytes, truncated, complete }; for a single stream, that stream object.' },
          render: textRender
        }
      });

      defTool({
        name: 'modal_sandbox_info',
        description: 'Inspect Modal Sandboxes. Without sandboxId: list every sandbox this session is tracking. With sandboxId: return running state, exit code (when finished), age, creation metadata, and — while running — the current tunnel URLs for any exposed ports (unknown IDs are re-attached by ID automatically).',
        parameters: {
          sandboxId: { type: 'string', description: 'Omit to list all tracked sandboxes.' }
        },
        execute: (args) => call('info', args, 90000),
        output: {
          schema: { type: 'json', description: 'JSON result: without sandboxId, { sandboxes: [{sandboxId, createdAt, meta, knownExitCode}] }; with one, { sandboxId, running, exitCode, ageMs, meta, tunnels }.' },
          render: textRender
        }
      });

      defTool({
        name: 'modal_sandbox_terminate',
        description: 'Terminate a Modal Sandbox in the cloud (it stops running; the sandboxId becomes unusable). Waits for full termination by default and returns the exit code when available.',
        parameters: {
          sandboxId: { type: 'string', required: true, description: 'Target sandbox ID.' },
          wait: { type: 'boolean', description: 'Wait for termination to complete. Defaults to true.' }
        },
        execute: (args) => call('terminate', args, 120000),
        output: {
          schema: { type: 'json', description: 'JSON result: { sandboxId, exitCode } (exitCode null when not captured).' },
          render: textRender
        }
      });

      defTool({
        name: 'modal_sandbox_set_credentials',
        description: 'Set the Modal API credentials for this session. Persists them to <workspace>/modal-sandbox/credentials.json (kept for restarts) and applies them to the running bridge immediately. Use when modal tools report that Modal credentials are not configured.',
        parameters: {
          tokenId: { type: 'string', required: true, description: 'MODAL_TOKEN_ID value.' },
          tokenSecret: { type: 'string', required: true, description: 'MODAL_TOKEN_SECRET value.' }
        },
        execute: (args) => {
          const next = { tokenId: String(args.tokenId), tokenSecret: String(args.tokenSecret) };
          creds = next;
          return fs.resolve(bridgeDir + '/credentials.json').then((t) => fs.writeText(t, JSON.stringify(next) + '\n')).then(() => call('configure', next, 15000)).then(() => ({ ok: true, persistedTo: bridgeDir + '/credentials.json' }));
        },
        output: {
          schema: { type: 'json', description: 'JSON result: { ok: true, persistedTo } (path of the written credentials.json).' },
          render: textRender
        }
      });

      // ---- lifecycle ------------------------------------------------------------

      const cleanupBridge = () => {
        const b = bridge;
        bridge = null;
        if (b && !b.dead) {
          void diag('cleanup: terminating bridge pid=' + b.handle.pid);
          try { b.handle.terminate(); } catch (e) {}
        } else {
          void diag('cleanup: bridge already dead/null');
        }
      };

      console.log('modal-sandbox: activating (bridge dir ' + bridgeDir + ')');
      void diag('activating (bridge dir ' + bridgeDir + ')');
      const bootstrap = Promise.resolve()
        .then(() => probeEnvCreds())
        .then((envCreds) => (envCreds ? envCreds : readServiceCreds()))
        .then((svcCreds) => (svcCreds ? svcCreds : readFileCreds()))
        .then((fileCreds) => {
          creds = fileCreds || null;
          return ensureBridge();
        })
        .then(() => console.log('modal-sandbox: ready (creds source: ' + (creds ? 'explicit' : 'ambient/fallback') + ')'))
        .catch((e) => {
          const msg = 'modal-sandbox: bootstrap failed (tools will retry on first use): ' + (e && e.message ? e.message : e);
          console.error(msg);
          void diag('bootstrap failed: ' + (e && e.message ? e.message : e));
        });

      ctx.effect(() => () => {
        for (const d of toolDisposers) { try { d(); } catch (e) {} }
      }, 'modal-sandbox: tools');
      ctx.effect(() => cleanupBridge, 'modal-sandbox: bridge');
      void bootstrap;
    }
  };
}
