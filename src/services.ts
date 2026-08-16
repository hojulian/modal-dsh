/**
 * Structural types for the DSH host services this plugin consumes.
 *
 * The plugin only touches a small, stable slice of `fs`, `subprocess`,
 * `credentials`, `timer` and `sandboxPolicy`; typing that slice locally keeps
 * the plugin compiling against any host build that still provides it, and
 * documents exactly what the plugin needs mounted in the composition.
 * @module modal-dsh/services
 */

export interface FsTarget {
  readonly path?: string
}

/** Target-based filesystem service. `writeText` creates missing parents. */
export interface FsService {
  resolve(path: string): Promise<FsTarget>
  readText(target: FsTarget): Promise<string>
  writeText(target: FsTarget, text: string): Promise<void>
  stat(target: FsTarget): Promise<unknown>
}

export interface CollectedStream {
  readFrom(offset: number): { text: string }
}

export interface WritableStdin {
  write(chunk: string): void
  on(event: 'error', listener: (error: Error) => void): void
}

export interface ReadableStdout {
  setEncoding(encoding: string): void
  on(event: 'data', listener: (chunk: unknown) => void): void
  on(event: 'close', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

export interface SpawnHandle {
  readonly pid: number
  readonly stdin: WritableStdin
  readonly stdout: ReadableStdout
  readonly collected?: { stdout?: CollectedStream, stderr?: CollectedStream }
  readonly done: Promise<{ exitCode: number | null, signal?: string | null }>
  waitForExit(): Promise<unknown>
  terminate(): void
}

export interface SpawnSpec {
  argv: string[]
  cwd: string
  stdio: Record<string, unknown>
  graceMs?: number
  env?: Record<string, string>
}

export interface SubprocessService {
  resolveExecutable(name: string): Promise<string>
  spawn(spec: SpawnSpec): SpawnHandle
}

export interface CredentialsService {
  describe(name: string): Promise<{ available?: boolean } | null>
  resolve(name: string): Promise<{ value?: string } | null>
}

/** Cancels the pending timeout when called. */
export type TimerDisposer = () => void

export interface TimerService {
  timeout(callback: () => void, ms: number): TimerDisposer
}

export interface SandboxPolicyService {
  readonly workspaceRoot?: string
}

/** The subset of the cordis context this plugin reads services from. */
export interface ServiceContext {
  get(name: 'fs'): FsService | undefined
  get(name: 'subprocess'): SubprocessService | undefined
  get(name: 'credentials'): CredentialsService | undefined
  get(name: 'timer'): TimerService | undefined
  get(name: 'sandboxPolicy'): SandboxPolicyService | undefined
  get(name: string): unknown
}

export interface HostServices {
  fs: FsService
  subprocess: SubprocessService
  credentials: CredentialsService | undefined
  timer: TimerService | undefined
  sandboxPolicy: SandboxPolicyService | undefined
}

/**
 * Pull the services out of a context, failing loudly when a required one is
 * not mounted in the composition.
 */
export function resolveServices(ctx: ServiceContext): HostServices {
  const fs = ctx.get('fs')
  const subprocess = ctx.get('subprocess')
  if (fs === undefined || subprocess === undefined) {
    throw new Error('modal-dsh needs the "fs" and "subprocess" services mounted in the composition')
  }
  return {
    fs,
    subprocess,
    credentials: ctx.get('credentials'),
    timer: ctx.get('timer'),
    sandboxPolicy: ctx.get('sandboxPolicy'),
  }
}
