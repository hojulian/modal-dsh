/**
 * Supervisor for the long-lived `bridge.mjs` child process.
 *
 * DSH plugin code cannot import the Modal SDK into the host process, so the
 * SDK lives in a child process addressed over newline-delimited JSON on stdio.
 * This module owns that child: it materializes the bridge files inside the
 * workspace, installs the SDK on first use, spawns and pings the bridge,
 * resolves credentials, and turns bridge responses back into promises.
 * @module modal-dsh/bridge-host
 */

import { readFileSync } from 'node:fs'
import type {
  CredentialsService,
  FsService,
  HostServices,
  SandboxPolicyService,
  SpawnHandle,
  SubprocessService,
  TimerDisposer,
  TimerService,
} from './services.js'

/** Modal API credentials, as the bridge's `configure` method expects them. */
export interface Credentials {
  tokenId: string
  tokenSecret: string
}

/** Tunables the plugin config feeds into the bridge host. */
export interface BridgeOptions {
  /** Workspace root override; defaults to the sandboxPolicy workspace root. */
  bridgeRoot?: string
  /** Modal app name the bridge creates sandboxes under. */
  appName: string
  /** Image used when a create call omits one. */
  defaultImage: string
}

export const CRED_HINT
  = 'Modal credentials are not configured. Provide them with modal_sandbox_set_credentials, '
    + 'set MODAL_TOKEN_ID/MODAL_TOKEN_SECRET in the host environment, or store a DSH credential '
    + 'named "modal" as "<token id> <token secret>".'

const FALLBACK_BRIDGE_ROOT = '/opt/dsh/workspace/dhs'
const CRED_ERROR_PATTERN = /unauthenticated|unauthorized|token_id or token_secret|modalclient constructor/i

/** package.json written next to the bridge so `npm install` can resolve the SDK. */
const BRIDGE_PKG = `${JSON.stringify(
  {
    name: 'modal-dsh-bridge',
    private: true,
    version: '0.1.0',
    type: 'module',
    description: 'Long-lived bridge process hosting the Modal JS SDK for the DSH modal-dsh plugin.',
    dependencies: { modal: '^0.9.0' },
  },
  null,
  2,
)}\n`

/** Read the bridge source that ships inside this package. */
export function packagedBridgeSource(): string {
  return readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8')
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: TimerDisposer | null
}

interface Bridge {
  handle: SpawnHandle
  pending: Map<number, Pending>
  seq: number
  dead: boolean
  starting: Promise<unknown> | null
  startedAt: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Owns one bridge child process and the request/response plumbing around it.
 *
 * A dead bridge is respawned on the next call: cloud state is never lost,
 * because the bridge re-attaches sandboxes by ID.
 */
export class BridgeHost {
  readonly bridgeDir: string
  readonly bridgePath: string

  private readonly fs: FsService
  private readonly subprocess: SubprocessService
  private readonly credentialsSvc: CredentialsService | undefined
  private readonly timer: TimerService | undefined
  private readonly options: BridgeOptions

  private bridge: Bridge | null = null
  private spawnInFlight: Promise<unknown> | null = null
  private creds: Credentials | null = null

  constructor(services: HostServices, options: BridgeOptions) {
    this.fs = services.fs
    this.subprocess = services.subprocess
    this.credentialsSvc = services.credentials
    this.timer = services.timer
    this.options = options
    this.bridgeDir = `${resolveRoot(options.bridgeRoot, services.sandboxPolicy)}/modal-dsh`
    this.bridgePath = `${this.bridgeDir}/bridge.mjs`
  }

  /** Path the credentials fallback file is written to. */
  get credentialsPath(): string {
    return `${this.bridgeDir}/credentials.json`
  }

  /** Credentials currently in effect, if any were resolved explicitly. */
  get credentials(): Credentials | null {
    return this.creds
  }

  /**
   * Resolve credentials and bring the bridge up.
   * Failures are the caller's to report; tools retry on first use.
   */
  async start(): Promise<void> {
    this.creds = await this.resolveCredentials()
    await this.ensureBridge()
  }

  /**
   * Call a bridge method, spawning the bridge first when needed.
   * @param method - bridge method name.
   * @param params - JSON parameters for the method.
   * @param timeoutMs - abandon the call after this long.
   */
  async call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    try {
      await this.ensureBridge()
      return await this.rawCall(method, params, timeoutMs)
    } catch (error) {
      const message = errorMessage(error)
      if (CRED_ERROR_PATTERN.test(message)) throw new Error(`${message} ${CRED_HINT}`)
      throw error
    }
  }

  /** Persist new credentials and hot-apply them to the running bridge. */
  async setCredentials(next: Credentials): Promise<{ ok: true, persistedTo: string }> {
    this.creds = next
    const target = await this.fs.resolve(this.credentialsPath)
    await this.fs.writeText(target, `${JSON.stringify(next)}\n`)
    await this.call('configure', { ...next }, 15000)
    return { ok: true, persistedTo: this.credentialsPath }
  }

  /** Terminate the child process; cloud sandboxes keep running. */
  stop(): void {
    const bridge = this.bridge
    this.bridge = null
    if (bridge !== null && !bridge.dead) {
      try {
        bridge.handle.terminate()
      } catch {
        // Already gone; nothing to clean up.
      }
    }
  }

  // ---- bootstrap ----------------------------------------------------------

  /**
   * Write the bridge source and manifest into the workspace, then install the
   * Modal SDK if it is not there yet.
   */
  private async ensureBridgeFiles(): Promise<void> {
    const source = packagedBridgeSource()
    const bridgeTarget = await this.fs.resolve(this.bridgePath)
    const existing = await this.fs.readText(bridgeTarget).catch(() => null)
    if (existing !== source) await this.fs.writeText(bridgeTarget, source)

    const pkgTarget = await this.fs.resolve(`${this.bridgeDir}/package.json`)
    const pkgExisting = await this.fs.readText(pkgTarget).catch(() => null)
    if (pkgExisting !== BRIDGE_PKG) await this.fs.writeText(pkgTarget, BRIDGE_PKG)

    const modalPkg = await this.fs.resolve(`${this.bridgeDir}/node_modules/modal/package.json`)
    if (await this.fs.stat(modalPkg)) return

    const npm = await this.subprocess.resolveExecutable('npm')
    const handle = this.subprocess.spawn({
      argv: [npm, 'install', '--no-audit', '--no-fund'],
      cwd: this.bridgeDir,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      graceMs: 5000,
    })
    const result = await handle.done
    if (result.exitCode !== 0) {
      const stderr = readCollected(handle, 'stderr')
      throw new Error(`npm install of the modal SDK failed (exit ${result.exitCode}): ${stderr.slice(-2000)}`)
    }
  }

  private async resolveCredentials(): Promise<Credentials | null> {
    return (await this.envCredentials())
      ?? (await this.serviceCredentials())
      ?? (await this.fileCredentials())
  }

  /** Read MODAL_* out of the host environment (via a throwaway node probe). */
  private async envCredentials(): Promise<Credentials | null> {
    const code
      = 'const t=process.env.MODAL_TOKEN_ID||"";const s=process.env.MODAL_TOKEN_SECRET||"";'
        + 'console.log(JSON.stringify({t:t,s:s}))'
    try {
      const node = await this.subprocess.resolveExecutable('node')
      const handle = this.subprocess.spawn({
        argv: [node, '-e', code],
        cwd: '/',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
        graceMs: 2000,
      })
      const result = await handle.done
      if (result.exitCode !== 0) return null
      const parsed = JSON.parse(readCollected(handle, 'stdout').trim()) as { t?: string, s?: string }
      if (parsed.t === undefined || parsed.t === '' || parsed.s === undefined || parsed.s === '') return null
      return { tokenId: parsed.t, tokenSecret: parsed.s }
    } catch {
      return null
    }
  }

  /** Read the DSH credential named `modal` ("<token id> <token secret>"). */
  private async serviceCredentials(): Promise<Credentials | null> {
    const svc = this.credentialsSvc
    if (svc === undefined) return null
    try {
      const info = await svc.describe('modal')
      if (info === null || info.available === false) return null
      const resolved = await svc.resolve('modal')
      const value = resolved?.value
      if (value === undefined || value === '') return null
      const parts = String(value).trim().split(/\s+/)
      if (parts.length !== 2) {
        throw new Error("the 'modal' credential should be '<token id> <token secret>'")
      }
      return { tokenId: parts[0]!, tokenSecret: parts[1]! }
    } catch (error) {
      console.error(`modal-dsh: credential service lookup failed: ${errorMessage(error)}`)
      return null
    }
  }

  /** Read credentials.json written by a previous set_credentials call. */
  private async fileCredentials(): Promise<Credentials | null> {
    try {
      const target = await this.fs.resolve(this.credentialsPath)
      const parsed = JSON.parse(await this.fs.readText(target)) as Partial<Credentials>
      if (parsed.tokenId === undefined || parsed.tokenSecret === undefined) return null
      return { tokenId: String(parsed.tokenId), tokenSecret: String(parsed.tokenSecret) }
    } catch {
      return null
    }
  }

  // ---- bridge plumbing ----------------------------------------------------

  private failPending(bridge: Bridge, error: Error): void {
    const pending = bridge.pending
    bridge.pending = new Map()
    for (const waiter of pending.values()) {
      if (waiter.timer !== null) waiter.timer()
      waiter.reject(error)
    }
  }

  private rawCall(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const bridge = this.bridge
    if (bridge === null) return Promise.reject(new Error('modal bridge is not running'))
    const id = ++bridge.seq
    return new Promise((resolve, reject) => {
      const waiter: Pending = { resolve, reject, timer: null }
      bridge.pending.set(id, waiter)
      if (this.timer !== undefined && timeoutMs > 0) {
        waiter.timer = this.timer.timeout(() => {
          if (bridge.pending.delete(id)) {
            waiter.timer = null
            reject(new Error(`bridge call ${method} timed out after ${timeoutMs}ms`))
          }
        }, timeoutMs)
      }
      try {
        bridge.handle.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      } catch (error) {
        if (bridge.pending.delete(id)) {
          if (waiter.timer !== null) waiter.timer()
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })
  }

  private async spawnBridge(): Promise<Bridge> {
    const node = await this.subprocess.resolveExecutable('node')
    const env: Record<string, string> = {
      MODAL_DSH_APP_NAME: this.options.appName,
      MODAL_DSH_DEFAULT_IMAGE: this.options.defaultImage,
    }
    if (this.creds !== null) {
      env.MODAL_TOKEN_ID = this.creds.tokenId
      env.MODAL_TOKEN_SECRET = this.creds.tokenSecret
    }
    const handle = this.subprocess.spawn({
      argv: [node, this.bridgePath],
      cwd: this.bridgeDir,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 } },
      graceMs: 5000,
      env,
    })
    const bridge: Bridge = {
      handle,
      pending: new Map(),
      seq: 0,
      dead: false,
      starting: null,
      startedAt: Date.now(),
    }
    this.bridge = bridge

    let buffer = ''
    try {
      handle.stdout.setEncoding('utf8')
    } catch {
      // Some hosts hand back an already-decoded stream.
    }
    handle.stdin.on('error', () => {})
    handle.stdout.on('error', () => {})
    handle.stdout.on('data', (chunk: unknown) => {
      if (bridge !== this.bridge || bridge.dead) return
      buffer += String(chunk)
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line === '') continue
        this.dispatchResponse(bridge, line)
      }
    })
    handle.stdout.on('close', () => {
      if (bridge !== this.bridge || bridge.dead) return
      bridge.dead = true
      const stderr = readCollected(handle, 'stderr')
      this.failPending(
        bridge,
        new Error(`modal bridge exited unexpectedly (pid ${handle.pid})${stderr === '' ? '' : `: ${stderr.slice(-2000)}`}`),
      )
    })
    handle.done.then(
      (result) => {
        if (bridge !== this.bridge || bridge.dead) return
        bridge.dead = true
        this.failPending(
          bridge,
          new Error(`modal bridge exited unexpectedly (exit ${result.exitCode} signal ${result.signal ?? 'none'})`),
        )
      },
      () => {},
    )

    bridge.starting = this.rawCall('ping', {}, 30000)
      .then(async (pong) => {
        if (this.creds === null) return pong
        return this.rawCall('configure', { ...this.creds }, 15000)
      })
      .catch((error: unknown) => {
        bridge.dead = true
        throw error
      })

    return bridge
  }

  private dispatchResponse(bridge: Bridge, line: string): void {
    let response: { id?: number, ok?: boolean, result?: unknown, error?: { message?: string } }
    try {
      response = JSON.parse(line)
    } catch {
      return // Non-protocol noise on stdout; stderr carries the diagnostics.
    }
    if (response.id === undefined) return
    const waiter = bridge.pending.get(response.id)
    if (waiter === undefined) return
    bridge.pending.delete(response.id)
    if (waiter.timer !== null) waiter.timer()
    if (response.ok === true) waiter.resolve(response.result === undefined ? null : response.result)
    else waiter.reject(new Error(response.error?.message ?? 'modal bridge error'))
  }

  /** Spawn the bridge if there is none, and wait for its handshake. */
  private async ensureBridge(): Promise<void> {
    // A concurrent spawn (e.g. the activation bootstrap) owns the race.
    if (this.spawnInFlight !== null) await this.spawnInFlight.catch(() => {})
    if (this.bridge === null || this.bridge.dead) {
      const inFlight = this.ensureBridgeFiles().then(() => this.spawnBridge())
      this.spawnInFlight = inFlight
      try {
        await inFlight
      } finally {
        this.spawnInFlight = null
      }
    }
    await this.bridge?.starting
  }
}

function resolveRoot(override: string | undefined, policy: SandboxPolicyService | undefined): string {
  if (override !== undefined && override !== '') return override.replace(/\/+$/, '')
  const workspaceRoot = policy?.workspaceRoot
  if (workspaceRoot !== undefined && workspaceRoot !== '') return workspaceRoot.replace(/\/+$/, '')
  return FALLBACK_BRIDGE_ROOT
}

function readCollected(handle: SpawnHandle, stream: 'stdout' | 'stderr'): string {
  try {
    return handle.collected?.[stream]?.readFrom(0).text ?? ''
  } catch {
    return ''
  }
}
