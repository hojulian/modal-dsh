/**
 * In-memory doubles for the DSH host services, so the plugin's real bootstrap,
 * spawn, and protocol paths can run in a unit test without a Modal account,
 * a workspace, or a child process.
 */

import type { HostServices, SpawnHandle, SpawnSpec } from '../src/services.js'

type Listener = (payload: never) => void

/** A scripted bridge process: JSON requests in, canned responses out. */
export class FakeProcess implements SpawnHandle {
  readonly pid = 4242
  readonly requests: { id: number, method: string, params: Record<string, unknown> }[] = []
  readonly collected = { stdout: reader(() => ''), stderr: reader(() => '') }

  /** Method name -> result, or a thrown-shaped error. */
  responses: Record<string, unknown | ((params: Record<string, unknown>) => unknown)> = {}

  private readonly listeners = new Map<string, Listener[]>()
  private resolveDone!: (value: { exitCode: number | null, signal?: string | null }) => void
  readonly done = new Promise<{ exitCode: number | null, signal?: string | null }>((resolve) => {
    this.resolveDone = resolve
  })

  readonly stdin = {
    write: (chunk: string) => {
      const request = JSON.parse(chunk) as { id: number, method: string, params: Record<string, unknown> }
      this.requests.push(request)
      const responder = this.responses[request.method]
      const result = typeof responder === 'function'
        ? (responder as (params: Record<string, unknown>) => unknown)(request.params)
        : responder ?? { ok: true }
      queueMicrotask(() => this.emitLine(JSON.stringify({ id: request.id, ok: true, result })))
    },
    on: () => {},
  }

  readonly stdout = {
    setEncoding: () => {},
    on: (event: string, listener: Listener) => {
      const list = this.listeners.get(event) ?? []
      list.push(listener)
      this.listeners.set(event, list)
    },
  } as never

  /** Push one protocol line to the plugin's stdout reader. */
  emitLine(line: string): void {
    for (const listener of this.listeners.get('data') ?? []) (listener as (chunk: string) => void)(`${line}\n`)
  }

  /** Simulate the bridge dying. */
  exit(exitCode: number): void {
    for (const listener of this.listeners.get('close') ?? []) (listener as () => void)()
    this.resolveDone({ exitCode, signal: null })
  }

  async waitForExit(): Promise<unknown> {
    return this.done
  }

  terminate(): void {
    this.exit(0)
  }
}

function reader(text: () => string) {
  return { readFrom: () => ({ text: text() }) }
}

export interface Fakes {
  services: HostServices
  files: Map<string, string>
  spawns: SpawnSpec[]
  processes: FakeProcess[]
}

/**
 * Build a host-services double.
 * @param options.installedModal - whether the Modal SDK already exists on disk
 * (false makes the bootstrap run its `npm install` path).
 */
export function createFakes(options: { installedModal?: boolean } = {}): Fakes {
  const files = new Map<string, string>()
  const spawns: SpawnSpec[] = []
  const processes: FakeProcess[] = []
  if (options.installedModal !== false) {
    files.set('/ws/modal-dsh/node_modules/modal/package.json', '{}')
  }

  const services: HostServices = {
    fs: {
      resolve: async (path: string) => ({ path }),
      readText: async (target) => {
        const text = files.get(String(target.path))
        if (text === undefined) throw new Error(`ENOENT ${String(target.path)}`)
        return text
      },
      writeText: async (target, text) => {
        files.set(String(target.path), text)
      },
      stat: async (target) => (files.has(String(target.path)) ? { size: 0 } : null),
    },
    subprocess: {
      resolveExecutable: async (bin: string) => `/usr/bin/${bin}`,
      spawn: (spec: SpawnSpec) => {
        spawns.push(spec)
        const proc = new FakeProcess()
        processes.push(proc)
        if (spec.argv[1] === '-e') {
          // The environment probe: report no ambient credentials.
          proc.collected.stdout.readFrom = () => ({ text: JSON.stringify({ t: '', s: '' }) })
          queueMicrotask(() => proc.exit(0))
        } else if (spec.argv[1] === 'install') {
          queueMicrotask(() => proc.exit(0))
        }
        return proc
      },
    },
    credentials: undefined,
    timer: { timeout: (callback, ms) => {
      const handle = setTimeout(callback, ms)
      return () => clearTimeout(handle)
    } },
    sandboxPolicy: { workspaceRoot: '/ws' },
  }

  return { services, files, spawns, processes }
}
