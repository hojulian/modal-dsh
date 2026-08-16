// modal-dsh: DSH Modal sandbox bridge
// ------------------------
// Long-lived child process that hosts the Modal JavaScript SDK on behalf of
// the DSH "modal-dsh" dynamic Cordis plugin (which cannot `require`
// modules in its restricted plain-JS execution environment).
//
// Protocol: newline-delimited JSON over stdin/stdout.
//   request:  {"id": <number>, "method": "<name>", "params": {...}}
//   response: {"id": <number>, "ok": true,  "result": <json>}
//             {"id": <number>, "ok": false, "error": {"message": "..."}}
//
// Diagnostics go to stderr only. The bridge owns one ModalClient and an
// in-memory registry of sandboxes (re-attachable by ID via fromId).

import { ModalClient } from 'modal';

const APP_NAME = 'modal-dsh-sandboxes';
const DEFAULT_IMAGE = 'python:3.13';
const MAX_MAIN_TAIL = 256 * 1024; // per main-process stream, retained tail
const MAX_EXEC_TAIL = 1024 * 1024; // per exec stream, retained tail
const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_EXEC_TIMEOUT_MS = 120 * 1000;
const MAX_EXEC_TIMEOUT_MS = 15 * 60 * 1000;

let client = null;
const configured = { tokenId: null, tokenSecret: null };
const sandboxes = new Map(); // sandboxId -> rec
const execs = new Map(); // `${sandboxId}:${execId}` -> rec
let execSeq = 0;

// Bounded tail buffer: keeps the last `max` bytes, counts all bytes.
class Tail {
  constructor(max) {
    this.max = max;
    this.buf = Buffer.alloc(0);
    this.total = 0;
    this.truncated = false;
  }
  push(text) {
    if (!text) return;
    const b = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
    this.total += b.length;
    this.buf = Buffer.concat([this.buf, b]);
    if (this.buf.length > this.max) {
      this.buf = this.buf.subarray(this.buf.length - this.max);
      this.truncated = true;
    }
  }
  read() {
    return this.buf.toString('utf8');
  }
  summary() {
    return { text: this.read(), totalBytes: this.total, truncated: this.truncated };
  }
}

process.stdout.on('error', (e) => log('stdout stream error: ' + (e && e.message ? e.message : e)));
process.stdin.on('error', (e) => log('stdin stream error: ' + (e && e.message ? e.message : e)));

function send(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch (e) {
    log('stdout write failed: ' + (e && e.message ? e.message : e));
  }
}

function log(...args) {
  try {
    process.stderr.write(args.map(String).join(' ') + '\n');
  } catch {}
}

function ensureClient() {
  if (client) return client;
  const params = {};
  if (configured.tokenId) params.tokenId = configured.tokenId;
  if (configured.tokenSecret) params.tokenSecret = configured.tokenSecret;
  // With no explicit credentials the SDK falls back to MODAL_TOKEN_ID /
  // MODAL_TOKEN_SECRET in its own environment and ~/.modal.toml.
  client = new ModalClient(params);
  log('modal client created (explicitCreds=' + (params.tokenId ? 'yes' : 'no') + ')');
  return client;
}

// Pump a web ReadableStream (text mode) into a Tail until it ends.
// Resolves when the stream is fully drained (or errors).
async function pump(stream, tail, label) {
  try {
    for await (const chunk of stream) {
      tail.push(chunk);
    }
  } catch (e) {
    log('pump ' + label + ' ended with error: ' + (e && e.message ? e.message : e));
  }
}

// After a process exits, the SDK may report the exit code BEFORE the stdout /
// stderr streams finish delivering their final bytes (verified empirically:
// reading the tails at exit-time yields empty output). Await both pumps so
// the retained tails are complete. Bounded so a stuck stream cannot hang a
// call; on timeout the (partial) tails are returned as-is.
async function drainExec(ex, label) {
  const drain = Promise.all([ex.stdoutDone, ex.stderrDone]);
  await Promise.race([
    drain,
    new Promise((r) => setTimeout(() => { log('drain ' + label + ' timed out; returning partial output'); r(); }, 10000))
  ]);
}

async function pollSafe(sandbox) {
  try {
    return await sandbox.poll();
  } catch (e) {
    log('poll error: ' + (e && e.message ? e.message : e));
    return null;
  }
}

async function attachSandbox(id, sandbox, meta) {
  const rec = {
    sandbox,
    meta: meta || {},
    createdAt: Date.now(),
    stdout: new Tail(MAX_MAIN_TAIL),
    stderr: new Tail(MAX_MAIN_TAIL),
    exitCode: null, // null = unknown/running
  };
  sandboxes.set(id, rec);
  const mainOut = sandbox.stdout;
  const mainErr = sandbox.stderr;
  pump(mainOut, rec.stdout, 'stdout').then(async () => {
    if (rec.exitCode === null) rec.exitCode = await pollSafe(sandbox);
  });
  pump(mainErr, rec.stderr, 'stderr').then(async () => {
    if (rec.exitCode === null) rec.exitCode = await pollSafe(sandbox);
  });
  return rec;
}

async function getOrAttach(sandboxId) {
  const rec = sandboxes.get(sandboxId);
  if (rec) return rec;
  const c = ensureClient();
  const sandbox = await c.sandboxes.fromId(sandboxId);
  return attachSandbox(sandboxId, sandbox, { attached: true });
}

async function tunnelList(sandbox, timeoutMs) {
  const rec = await sandbox.tunnels(timeoutMs);
  return Object.entries(rec).map(([port, t]) => ({ port: Number(port), url: t.url }));
}

function raceTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve('__timeout__'), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

// Common exec response shape: retained tails plus caller-provided fields.
// A failed stdin write (ex.stdinError) is surfaced here rather than swallowed.
function execPayload(ex, fields) {
  const out = Object.assign(
    { stdout: ex.stdout.read(), stderr: ex.stderr.read(), truncated: ex.stdout.truncated || ex.stderr.truncated },
    fields
  );
  if (ex.stdinError) out.stdinError = ex.stdinError;
  return out;
}

const execKey = (sandboxId, execId) => sandboxId + ':' + execId;

// ---- methods -------------------------------------------------------------

function mPing() {
  return { pong: true, sandboxCount: sandboxes.size, execCount: execs.size };
}

function mStatus() {
  return {
    sandboxCount: sandboxes.size,
    execCount: execs.size,
    hasExplicitCreds: !!(configured.tokenId && configured.tokenSecret),
    clientCreated: !!client,
  };
}

function mConfigure(p) {
  if (p.tokenId) configured.tokenId = String(p.tokenId);
  if (p.tokenSecret) configured.tokenSecret = String(p.tokenSecret);
  // A client built with different credentials must be rebuilt.
  if (client) {
    try {
      client.close();
    } catch (e) {
      log('client.close error: ' + e.message);
    }
    client = null;
  }
  return { ok: true };
}

async function mCreate(p) {
  const c = ensureClient();
  const app = await c.apps.fromName(APP_NAME, { createIfMissing: true });
  const imageTag = p.image || DEFAULT_IMAGE;
  let image = c.images.fromRegistry(imageTag);
  if (Array.isArray(p.dockerfileCommands) && p.dockerfileCommands.length > 0) {
    image = image.dockerfileCommands(p.dockerfileCommands);
  }
  const createParams = {};
  for (const k of ['cpu', 'cpuLimit', 'memoryMiB', 'memoryLimitMiB', 'gpu', 'workdir', 'command', 'env', 'pty', 'blockNetwork', 'name', 'cloud', 'regions']) {
    if (p[k] !== undefined) createParams[k] = p[k];
  }
  createParams.timeoutMs = p.timeoutMs !== undefined ? p.timeoutMs : DEFAULT_SANDBOX_TIMEOUT_MS;
  createParams.idleTimeoutMs = p.idleTimeoutMs !== undefined ? p.idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS;
  if (Array.isArray(p.encryptedPorts) && p.encryptedPorts.length > 0) createParams.encryptedPorts = p.encryptedPorts;
  if (Array.isArray(p.unencryptedPorts) && p.unencryptedPorts.length > 0) createParams.unencryptedPorts = p.unencryptedPorts;

  const sandbox = await c.sandboxes.create(app, image, createParams);
  await attachSandbox(sandbox.sandboxId, sandbox, {
    image: imageTag,
    command: Array.isArray(p.command) ? p.command : null,
    ports: [].concat(p.encryptedPorts || [], p.unencryptedPorts || []),
  });

  let tunnels = null;
  const ports = createParams.encryptedPorts || createParams.unencryptedPorts;
  if (ports && ports.length > 0) {
    try {
      tunnels = await tunnelList(sandbox, 60000);
    } catch (e) {
      tunnels = { error: 'tunnels not ready: ' + (e && e.message ? e.message : String(e)) };
    }
  }
  return { sandboxId: sandbox.sandboxId, appId: app.appId, image: imageTag, tunnels };
}

async function mExec(p) {
  const rec = await getOrAttach(p.sandboxId);
  if (!Array.isArray(p.command) || p.command.length === 0) throw new Error('command must be a non-empty string array');
  const timeoutMs = Math.min(Math.max(Number(p.timeoutMs) || DEFAULT_EXEC_TIMEOUT_MS, 1), MAX_EXEC_TIMEOUT_MS);
  const execParams = {};
  if (p.workdir) execParams.workdir = p.workdir;
  if (p.env) execParams.env = p.env;
  const proc = await rec.sandbox.exec(p.command, execParams);
  const execId = 'e' + ++execSeq;
  const ex = {
    sandboxId: p.sandboxId,
    proc,
    stdout: new Tail(MAX_EXEC_TAIL),
    stderr: new Tail(MAX_EXEC_TAIL),
    exitCode: null,
    error: null,
    startedAt: Date.now(),
  };
  execs.set(execKey(p.sandboxId, execId), ex);
  ex.exitPromise = proc.wait().then((code) => {
    ex.exitCode = code;
    return code;
  });
  ex.stdoutDone = pump(proc.stdout, ex.stdout, 'exec:' + execId + ':stdout');
  ex.stderrDone = pump(proc.stderr, ex.stderr, 'exec:' + execId + ':stderr');

  if (p.stdin) {
    try {
      await proc.stdin.writeText(String(p.stdin));
      await proc.stdin.close();
    } catch (e) {
      ex.stdinError = e && e.message ? e.message : String(e);
    }
  }

  let code;
  try {
    code = await raceTimeout(ex.exitPromise, timeoutMs);
  } catch (e) {
    ex.error = e && e.message ? e.message : String(e);
    execs.delete(execKey(p.sandboxId, execId));
    return execPayload(ex, { execId, exitCode: null, running: false, error: 'exec failed: ' + ex.error });
  }
  if (code === '__timeout__') {
    // Still running: the streams are still open. Return the partial tail and
    // keep the record so exec_wait can join it. Do NOT drain (would block).
    return execPayload(ex, {
      execId,
      exitCode: null,
      running: true,
      note: 'still running after ' + timeoutMs + 'ms; use modal_sandbox_exec_wait with this execId',
    });
  }
  // Process exited: make sure the stdout/stderr streams are fully drained
  // before reading the retained tails (the SDK reports exit before the
  // final bytes are flushed to the streams).
  await drainExec(ex, 'exec:' + execId);
  execs.delete(execKey(p.sandboxId, execId));
  return execPayload(ex, { execId, exitCode: code, running: false });
}

async function mExecWait(p) {
  const ex = execs.get(execKey(p.sandboxId, p.execId));
  if (!ex) throw new Error('unknown execId ' + p.execId + ' for sandbox ' + p.sandboxId);
  const timeoutMs = Math.min(Math.max(Number(p.timeoutMs) || DEFAULT_EXEC_TIMEOUT_MS, 1), MAX_EXEC_TIMEOUT_MS);
  let code;
  try {
    code = await raceTimeout(ex.exitPromise, timeoutMs);
  } catch (e) {
    ex.error = e && e.message ? e.message : String(e);
    execs.delete(execKey(p.sandboxId, p.execId));
    return execPayload(ex, { exitCode: null, running: false, error: 'exec failed: ' + ex.error });
  }
  if (code === '__timeout__') {
    // Still running: return the partial tail; the record stays for a later join.
    return execPayload(ex, { exitCode: null, running: true });
  }
  // Process exited: drain the streams before the final read (see mExec).
  await drainExec(ex, 'execwait:' + p.execId);
  execs.delete(execKey(p.sandboxId, p.execId));
  return execPayload(ex, { exitCode: code, running: false });
}

function mOutput(p) {
  const rec = sandboxes.get(p.sandboxId);
  if (!rec) throw new Error('sandbox not tracked by this bridge; call modal_sandbox_info first to attach');
  const pick = (which) => {
    if (which === 'both' || which === 'stdout') {
      const t = rec.stdout.summary();
      t.complete = rec.exitCode !== null;
      return t;
    }
    if (which === 'stderr') {
      const t = rec.stderr.summary();
      t.complete = rec.exitCode !== null;
      return t;
    }
    throw new Error('stream must be stdout, stderr, or both');
  };
  const stream = p.stream || 'both';
  const both = stream === 'both';
  return both ? { stdout: pick('stdout'), stderr: pick('stderr') } : pick(stream);
}

async function mInfo(p) {
  if (!p.sandboxId) {
    const list = [];
    for (const [id, rec] of sandboxes.entries()) {
      list.push({ sandboxId: id, createdAt: rec.createdAt, meta: rec.meta, knownExitCode: rec.exitCode });
    }
    return { sandboxes: list };
  }
  const rec = await getOrAttach(p.sandboxId);
  const code = rec.exitCode === null ? await pollSafe(rec.sandbox) : rec.exitCode;
  rec.exitCode = code;
  let tunnels = null;
  if (code === null) {
    try {
      tunnels = await tunnelList(rec.sandbox, 30000);
    } catch (e) {
      tunnels = { error: 'tunnels not ready: ' + (e && e.message ? e.message : String(e)) };
    }
  }
  return {
    sandboxId: p.sandboxId,
    running: code === null,
    exitCode: code,
    ageMs: Date.now() - rec.createdAt,
    meta: rec.meta,
    tunnels,
  };
}

async function mTerminate(p) {
  const rec = sandboxes.get(p.sandboxId);
  if (!rec) {
    // Not tracked here (e.g. created before a bridge restart): attach, then terminate.
    await getOrAttach(p.sandboxId);
  }
  const r = sandboxes.get(p.sandboxId);
  let exitCode = null;
  if (p.wait === false) {
    await r.sandbox.terminate();
  } else {
    try {
      exitCode = await r.sandbox.terminate({ wait: true });
    } catch (e) {
      log('terminate error: ' + (e && e.message ? e.message : e));
    }
  }
  sandboxes.delete(p.sandboxId);
  try {
    r.sandbox.detach();
  } catch {}
  for (const k of [...execs.keys()]) {
    if (k.startsWith(p.sandboxId + ':')) execs.delete(k);
  }
  return { sandboxId: p.sandboxId, exitCode };
}

const METHODS = {
  ping: mPing,
  status: mStatus,
  configure: mConfigure,
  create: mCreate,
  exec: mExec,
  execWait: mExecWait,
  output: mOutput,
  info: mInfo,
  terminate: mTerminate,
};

// ---- protocol loop ---------------------------------------------------------

let inputBuf = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuf += chunk;
  let idx;
  while ((idx = inputBuf.indexOf('\n')) >= 0) {
    const line = inputBuf.slice(0, idx).trim();
    inputBuf = inputBuf.slice(idx + 1);
    if (line) handleLine(line);
  }
});
process.stdin.on('close', () => shutdown('stdin closed'));

function handleLine(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    send({ id: null, ok: false, error: { message: 'bad request json: ' + e.message } });
    return;
  }
  const method = METHODS[req.method];
  if (!method) {
    send({ id: req.id, ok: false, error: { message: 'unknown method: ' + req.method } });
    return;
  }
  Promise.resolve(method(req.params || {}))
    .then((result) => send({ id: req.id, ok: true, result: result === undefined ? null : result }))
    .catch((e) => send({ id: req.id, ok: false, error: { message: (e && e.message ? e.message : String(e)) } }));
}

function shutdown(reason) {
  try {
    if (client) client.close();
  } catch {}
  log('bridge shutting down (' + (reason || 'signal/exit') + ')');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Exit so the plugin respawns a fresh bridge: the bridge is stateless with
// respect to the cloud (sandboxes re-attach by ID), and a process that has
// hit an uncaught exception may be left half-broken.
process.on('uncaughtException', (e) => {
  log('uncaughtException: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e && e.stack ? e.stack : e)));
