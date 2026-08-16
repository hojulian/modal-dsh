import { describe, expect, it } from 'vitest'
import { BridgeHost, packagedBridgeSource } from '../src/bridge-host.js'
import { createTools, execTimeout, withCancel } from '../src/tools.js'
import { createFakes } from './fakes.js'

const options = { bridgeRoot: undefined, appName: 'test-app', defaultImage: 'python:3.13' }

describe('bridge bootstrap', () => {
  it('materializes the packaged bridge source and manifest in the workspace', async () => {
    const fakes = createFakes()
    const host = new BridgeHost(fakes.services, options)
    await host.start()

    expect(host.bridgeDir).toBe('/ws/modal-dsh')
    expect(fakes.files.get('/ws/modal-dsh/bridge.mjs')).toBe(packagedBridgeSource())
    expect(JSON.parse(fakes.files.get('/ws/modal-dsh/package.json')!).dependencies.modal).toBe('^0.9.0')
  })

  it('installs the Modal SDK only when it is missing', async () => {
    const withSdk = createFakes()
    await new BridgeHost(withSdk.services, options).start()
    expect(withSdk.spawns.some((spec) => spec.argv[1] === 'install')).toBe(false)

    const withoutSdk = createFakes({ installedModal: false })
    await new BridgeHost(withoutSdk.services, options).start()
    expect(withoutSdk.spawns.some((spec) => spec.argv[1] === 'install')).toBe(true)
  })

  it('pings the bridge and passes the app config through the environment', async () => {
    const fakes = createFakes()
    const host = new BridgeHost(fakes.services, options)
    await host.start()

    const bridgeSpawn = fakes.spawns.find((spec) => spec.argv[1] === '/ws/modal-dsh/bridge.mjs')!
    expect(bridgeSpawn.env?.MODAL_DSH_APP_NAME).toBe('test-app')
    expect(bridgeSpawn.env?.MODAL_TOKEN_ID).toBeUndefined() // no ambient credentials in the fake
    const bridgeProc = fakes.processes.at(-1)!
    expect(bridgeProc.requests[0]?.method).toBe('ping')
  })
})

describe('bridge calls', () => {
  it('round-trips a request and its response', async () => {
    const fakes = createFakes()
    const host = new BridgeHost(fakes.services, options)
    await host.start()
    fakes.processes.at(-1)!.responses.info = { sandboxes: [] }

    await expect(host.call('info', {}, 1000)).resolves.toEqual({ sandboxes: [] })
  })

  it('appends the credential hint to authentication failures', async () => {
    const fakes = createFakes()
    const host = new BridgeHost(fakes.services, options)
    await host.start()
    const proc = fakes.processes.at(-1)!
    proc.stdin.write = (chunk: string) => {
      const { id } = JSON.parse(chunk) as { id: number }
      queueMicrotask(() => proc.emitLine(JSON.stringify({ id, ok: false, error: { message: 'unauthenticated' } })))
    }

    await expect(host.call('info', {}, 1000)).rejects.toThrow(/modal_sandbox_set_credentials/)
  })

  it('times out a call the bridge never answers', async () => {
    const fakes = createFakes()
    const host = new BridgeHost(fakes.services, options)
    await host.start()
    fakes.processes.at(-1)!.stdin.write = () => {}

    await expect(host.call('info', {}, 20)).rejects.toThrow(/timed out after 20ms/)
  })

  it('fails pending calls when the bridge dies', async () => {
    const fakes = createFakes()
    const host = new BridgeHost(fakes.services, options)
    await host.start()
    const proc = fakes.processes.at(-1)!
    let written = false
    proc.stdin.write = () => { written = true }

    const pending = host.call('info', {}, 0)
    while (!written) await new Promise((resolve) => setTimeout(resolve, 1))
    proc.exit(1)
    await expect(pending).rejects.toThrow(/exited unexpectedly/)
  })

  it('persists credentials and hot-applies them', async () => {
    const fakes = createFakes()
    const host = new BridgeHost(fakes.services, options)
    await host.start()

    const result = await host.setCredentials({ tokenId: 'ak-1', tokenSecret: 'as-1' })
    expect(result).toEqual({ ok: true, persistedTo: '/ws/modal-dsh/credentials.json' })
    expect(JSON.parse(fakes.files.get('/ws/modal-dsh/credentials.json')!)).toEqual({ tokenId: 'ak-1', tokenSecret: 'as-1' })
    expect(fakes.processes.at(-1)!.requests.some((request) => request.method === 'configure')).toBe(true)
  })
})

describe('tools', () => {
  it('forwards tool arguments to the matching bridge method', async () => {
    const fakes = createFakes()
    const host = new BridgeHost(fakes.services, options)
    await host.start()
    const tools = createTools(host) as {
      name: string
      execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
      output: { render(args: unknown, value: unknown): { text: string }[] }
    }[]

    const exec = tools.find((tool) => tool.name === 'modal_sandbox_exec')!
    fakes.processes.at(-1)!.responses.exec = { exitCode: 0, stdout: 'hi\n', stderr: '' }
    const result = await exec.execute(
      { sandboxId: 'sb-1', command: ['bash', '-lc', 'echo hi'] },
      { signal: new AbortController().signal },
    )

    expect(result).toEqual({ exitCode: 0, stdout: 'hi\n', stderr: '' })
    const request = fakes.processes.at(-1)!.requests.at(-1)!
    expect(request.method).toBe('exec')
    expect(request.params.sandboxId).toBe('sb-1')
    expect(exec.output.render({}, result).map((block) => block.text).join('')).toContain('"exitCode": 0')
  })

  it('rejects when the caller cancels', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(withCancel(new Promise(() => {}), controller.signal)).rejects.toThrow('cancelled')
  })

  it('clamps exec timeouts into the range the bridge accepts', () => {
    expect(execTimeout(undefined)).toBe(120000)
    expect(execTimeout(0)).toBe(120000)
    expect(execTimeout('nope')).toBe(120000)
    expect(execTimeout(5000)).toBe(5000)
    expect(execTimeout(99999999)).toBe(900000)
  })
})
