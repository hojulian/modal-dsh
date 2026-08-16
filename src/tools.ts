/**
 * The model-facing tool surface: seven `modal_sandbox_*` tools, each a thin,
 * schema-validated wrapper over one bridge method.
 *
 * Every tool returns canonical JSON and renders it as pretty-printed text, so
 * the model sees exactly the values it can feed back into the next call.
 * @module modal-dsh/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { BridgeHost } from './bridge-host.js'

/** The slice of the tool exec context this plugin uses. */
export interface ToolExec {
  signal: AbortSignal
}

/**
 * Structurally identical to the host's `JsonValue`. Declared locally so the
 * plugin does not depend on `@deepseek-ai/dsh-session` just for a type; bridge
 * results are JSON by construction, so the cast at the call site is sound.
 */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const MIN_EXEC_TIMEOUT_MS = 1
const MAX_EXEC_TIMEOUT_MS = 900000
const DEFAULT_EXEC_TIMEOUT_MS = 120000

const textRender = (_args: unknown, value: unknown) => [
  { type: 'text' as const, text: JSON.stringify(value, null, 2) },
]

/** Clamp a caller-supplied exec timeout into the range the bridge accepts. */
export function execTimeout(raw: unknown): number {
  const requested = Number(raw)
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_EXEC_TIMEOUT_MS
  return Math.min(Math.max(requested, MIN_EXEC_TIMEOUT_MS), MAX_EXEC_TIMEOUT_MS)
}

/**
 * Reject as soon as the caller cancels, without waiting for the bridge.
 * The bridge keeps its own timeout, so an abandoned call cannot leak a waiter.
 * @param promise - the in-flight bridge call.
 * @param signal - caller cancellation signal.
 */
export function withCancel<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('modal-dsh: cancelled'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('modal-dsh: cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Build every tool definition for a bridge host.
 * @param host - the bridge supervisor the tools call through.
 */
export function createTools(host: BridgeHost): unknown[] {
  const call = (method: string, params: Record<string, unknown>, timeoutMs: number, exec: ToolExec) =>
    withCancel(host.call(method, params, timeoutMs), exec.signal) as Promise<JsonValue>

  return [
    defineTool({
      name: 'modal_sandbox_create',
      description:
        'Create a Modal Sandbox: a secure, isolated cloud container that boots in seconds. The sandbox keeps '
        + 'running in the cloud after this call returns (it is not local). Omit command to keep it idle; pass '
        + 'command to start a long-running main process (e.g. a web server). Pass encryptedPorts to expose '
        + 'container ports as public HTTPS tunnel URLs. Use the returned sandboxId with modal_sandbox_exec / '
        + 'modal_sandbox_output / modal_sandbox_info / modal_sandbox_terminate.',
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
        blockNetwork: { type: 'boolean', description: 'Block all outbound network from the sandbox.' },
      },
      execute: (args: Record<string, unknown>, exec: ToolExec) => call('create', args, 240000, exec),
      output: {
        schema: { type: 'json', description: 'JSON result: the created sandbox, at least { sandboxId } plus any returned descriptor fields.' },
        render: textRender,
      },
      presentCall: (args: { image?: string }) => ({
        card: 'generic',
        title: `Create Modal sandbox (${args.image ?? 'python:3.13'})`,
        kind: 'other',
        rawInput: args,
      }),
    }),

    defineTool({
      name: 'modal_sandbox_exec',
      description:
        'Run a command inside a Modal Sandbox and wait up to timeoutMs (default 120s) for it to finish. Returns '
        + 'the exit code plus captured stdout/stderr. If the command is still running when the wait elapses it '
        + 'keeps running in the sandbox and the result has running=true with an execId: call '
        + 'modal_sandbox_exec_wait with that execId to join it later. sandboxId may be any sandbox created by '
        + 'modal_sandbox_create (or previously attached); unknown IDs are re-attached by ID.',
      parameters: {
        sandboxId: { type: 'string', required: true, description: 'Target sandbox ID.' },
        command: { type: 'array', items: { type: 'string' }, required: true, description: 'argv to run, e.g. ["bash","-lc","echo hello && python3 -V"]' },
        workdir: { type: 'string', description: 'Working directory for the command.' },
        env: { type: 'json', description: 'Extra environment variables for the command.' },
        stdin: { type: 'string', description: 'Optional text written to the process stdin, followed by EOF.' },
        timeoutMs: { type: 'number', description: 'Maximum wait in ms (1..900000, default 120000). A timeout is NOT a failure.' },
      },
      execute: (args: Record<string, unknown>, exec: ToolExec) =>
        call('exec', args, execTimeout(args.timeoutMs) + 60000, exec),
      output: {
        schema: { type: 'json', description: 'JSON result: exec outcome — { exitCode, stdout, stderr } and, when the wait elapsed, { running: true, execId }.' },
        render: textRender,
      },
      presentCall: (args: { command?: string[] }) => ({
        card: 'generic',
        title: `Run in sandbox: ${(args.command ?? []).join(' ').slice(0, 80)}`,
        kind: 'execute',
        rawInput: args,
      }),
    }),

    defineTool({
      name: 'modal_sandbox_exec_wait',
      description:
        'Join a command that modal_sandbox_exec reported as still running (running=true). Returns the exit code '
        + 'and the full captured stdout/stderr once the command finishes, or running=true again if it is still '
        + 'going after timeoutMs.',
      parameters: {
        sandboxId: { type: 'string', required: true, description: 'Sandbox ID the execId belongs to.' },
        execId: { type: 'string', required: true, description: 'execId returned by modal_sandbox_exec.' },
        timeoutMs: { type: 'number', description: 'Maximum wait in ms (1..900000, default 120000).' },
      },
      execute: (args: Record<string, unknown>, exec: ToolExec) =>
        call('execWait', args, execTimeout(args.timeoutMs) + 30000, exec),
      output: {
        schema: { type: 'json', description: 'JSON result: { exitCode, running, stdout, stderr, truncated }, or { error } when the exec itself failed.' },
        render: textRender,
      },
      presentCall: (args: { execId?: string }) => ({
        card: 'generic',
        title: `Wait for exec ${args.execId ?? ''}`,
        kind: 'other',
        rawInput: args,
      }),
    }),

    defineTool({
      name: 'modal_sandbox_output',
      description:
        'Read the buffered main-process output of a Modal Sandbox (the process started by the sandbox command, '
        + 'not an exec). Returns up to the retained tail (256KB) per stream with totalBytes and a truncated '
        + 'flag, plus complete=true once the main process has exited.',
      parameters: {
        sandboxId: { type: 'string', required: true, description: 'Target sandbox ID.' },
        stream: { type: 'string', enum: ['stdout', 'stderr', 'both'], description: 'Which stream to read. Defaults to both.' },
      },
      execute: (args: Record<string, unknown>, exec: ToolExec) => call('output', args, 30000, exec),
      output: {
        schema: { type: 'json', description: 'JSON result: for "both", { stdout, stderr } each { text, totalBytes, truncated, complete }; for a single stream, that stream object.' },
        render: textRender,
      },
      presentCall: (args: { sandboxId?: string }) => ({
        card: 'generic',
        title: `Read output of ${args.sandboxId ?? 'sandbox'}`,
        kind: 'read',
        rawInput: args,
      }),
    }),

    defineTool({
      name: 'modal_sandbox_info',
      description:
        'Inspect Modal Sandboxes. Without sandboxId: list every sandbox this session is tracking. With '
        + 'sandboxId: return running state, exit code (when finished), age, creation metadata, and — while '
        + 'running — the current tunnel URLs for any exposed ports (unknown IDs are re-attached by ID '
        + 'automatically).',
      parameters: {
        sandboxId: { type: 'string', description: 'Omit to list all tracked sandboxes.' },
      },
      execute: (args: Record<string, unknown>, exec: ToolExec) => call('info', args, 90000, exec),
      output: {
        schema: { type: 'json', description: 'JSON result: without sandboxId, { sandboxes: [{sandboxId, createdAt, meta, knownExitCode}] }; with one, { sandboxId, running, exitCode, ageMs, meta, tunnels }.' },
        render: textRender,
      },
      presentCall: (args: { sandboxId?: string }) => ({
        card: 'generic',
        title: args.sandboxId === undefined ? 'List Modal sandboxes' : `Inspect ${args.sandboxId}`,
        kind: 'read',
        rawInput: args,
      }),
    }),

    defineTool({
      name: 'modal_sandbox_terminate',
      description:
        'Terminate a Modal Sandbox in the cloud (it stops running; the sandboxId becomes unusable). Waits for '
        + 'full termination by default and returns the exit code when available.',
      parameters: {
        sandboxId: { type: 'string', required: true, description: 'Target sandbox ID.' },
        wait: { type: 'boolean', description: 'Wait for termination to complete. Defaults to true.' },
      },
      execute: (args: Record<string, unknown>, exec: ToolExec) => call('terminate', args, 120000, exec),
      output: {
        schema: { type: 'json', description: 'JSON result: { sandboxId, exitCode } (exitCode null when not captured).' },
        render: textRender,
      },
      presentCall: (args: { sandboxId?: string }) => ({
        card: 'generic',
        title: `Terminate ${args.sandboxId ?? 'sandbox'}`,
        kind: 'other',
        rawInput: args,
      }),
    }),

    defineTool({
      name: 'modal_sandbox_set_credentials',
      description:
        'Set the Modal API credentials for this session. Persists them next to the bridge and applies them to '
        + 'the running bridge immediately. Use when modal tools report that Modal credentials are not configured.',
      parameters: {
        tokenId: { type: 'string', required: true, description: 'MODAL_TOKEN_ID value.' },
        tokenSecret: { type: 'string', required: true, description: 'MODAL_TOKEN_SECRET value.' },
      },
      execute: (args: { tokenId: string, tokenSecret: string }, exec: ToolExec) =>
        withCancel(
          host.setCredentials({ tokenId: String(args.tokenId), tokenSecret: String(args.tokenSecret) }),
          exec.signal,
        ),
      output: {
        schema: { type: 'json', description: 'JSON result: { ok: true, persistedTo } (path of the written credentials.json).' },
        render: textRender,
      },
      // Token values are deliberately kept out of the presented card.
      presentCall: () => ({
        card: 'generic',
        title: 'Set Modal credentials',
        kind: 'other',
        rawInput: {},
      }),
    }),
  ]
}
