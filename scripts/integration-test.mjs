#!/usr/bin/env node
/**
 * Packaged integration + real runtime invocation smoke test.
 *
 * Installs the ACTUAL pnpm-packed tarball into a fresh project, loads the
 * installed plugin bundle, registers the modal_sandbox_* tools through the
 * real `apply()` / `ctx.tools.register` path, drives the real bridge-host
 * bootstrap against scripted host services (no Modal account required),
 * executes a real tool handler end to end, renders the result through the
 * real renderer, and asserts every step. A missing module, an API mismatch,
 * or a handler failure fails this script.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tgz = path.resolve(process.argv[2] ?? path.join(root, 'modal-dsh-0.1.0.tgz'))

if (!existsSync(tgz)) {
  console.error(`[integration] missing tarball: ${tgz}`)
  process.exit(1)
}

function runPnpm(args, cwd) {
  if (process.platform === 'win32') {
    return spawnSync(`pnpm ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true })
  }
  return spawnSync('pnpm', args, { cwd, stdio: 'inherit' })
}

/** Scripted stand-ins for the DSH host services the plugin consumes. */
function hostServices() {
  const files = new Map([['/ws/modal-dsh/node_modules/modal/package.json', '{}']])
  const processes = []

  function fakeProcess(spec) {
    const listeners = new Map()
    let resolveDone
    const done = new Promise((resolve) => { resolveDone = resolve })
    const proc = {
      pid: 4242,
      requests: [],
      responses: {},
      collected: { stdout: { readFrom: () => ({ text: proc.probeText ?? '' }) }, stderr: { readFrom: () => ({ text: '' }) } },
      stdin: {
        write: (chunk) => {
          const request = JSON.parse(chunk)
          proc.requests.push(request)
          const result = proc.responses[request.method] ?? { ok: true }
          queueMicrotask(() => {
            for (const listener of listeners.get('data') ?? []) {
              listener(`${JSON.stringify({ id: request.id, ok: true, result })}\n`)
            }
          })
        },
        on: () => {},
      },
      stdout: {
        setEncoding: () => {},
        on: (event, listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]) },
      },
      done,
      waitForExit: () => done,
      terminate: () => resolveDone({ exitCode: 0, signal: null }),
    }
    if (spec.argv[1] === '-e') {
      proc.probeText = JSON.stringify({ t: '', s: '' })
      queueMicrotask(() => resolveDone({ exitCode: 0, signal: null }))
    } else if (spec.argv[1] === 'install') {
      queueMicrotask(() => resolveDone({ exitCode: 0, signal: null }))
    }
    processes.push(proc)
    return proc
  }

  return {
    files,
    processes,
    services: {
      fs: {
        resolve: async (p) => ({ path: p }),
        readText: async (t) => {
          if (!files.has(t.path)) throw new Error(`ENOENT ${t.path}`)
          return files.get(t.path)
        },
        writeText: async (t, text) => { files.set(t.path, text) },
        stat: async (t) => (files.has(t.path) ? { size: 0 } : null),
      },
      subprocess: {
        resolveExecutable: async (bin) => `/usr/bin/${bin}`,
        spawn: fakeProcess,
      },
      timer: {
        timeout: (cb, ms) => { const h = setTimeout(cb, ms); return () => clearTimeout(h) },
      },
      sandboxPolicy: { workspaceRoot: '/ws' },
    },
  }
}

async function scenario(name, dshToolsVersion, expectGuard) {
  const dir = mkdtempSync(path.join(tmpdir(), `modal-dsh-${name}-`))
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'modal-dsh-integration-host',
        private: true,
        version: '1.0.0',
        dependencies: {
          '@deepseek-ai/cordis': '^4.0.1',
          '@deepseek-ai/dsh-tools': dshToolsVersion,
          '@deepseek-ai/schemastery': '^3.18.1',
          'modal-dsh': `file:${tgz.replaceAll('\\', '/')}`,
        },
      },
      null,
      2,
    ),
  )

  console.log(`[integration:${name}] installing packed tarball into fresh project (dsh-tools ${dshToolsVersion})...`)
  const install = runPnpm(['install'], dir)
  if (install.status !== 0) {
    console.error(`[integration:${name}] pnpm install failed`)
    process.exit(1)
  }

  const installed = path.join(dir, 'node_modules', 'modal-dsh')
  const pluginIndex = path.join(installed, 'lib', 'index.js')
  if (!existsSync(pluginIndex)) {
    throw new Error('packed plugin entry lib/index.js missing after install')
  }
  const packagedBridge = path.join(installed, 'lib', 'bridge.mjs')
  if (!existsSync(packagedBridge)) {
    throw new Error('packed runtime bridge lib/bridge.mjs missing after install')
  }

  console.log(`[integration:${name}] loading packed plugin bundle...`)
  const plugin = await import(pathToFileURL(pluginIndex).href)

  if (plugin.name !== 'modal-dsh') {
    throw new Error(`unexpected plugin name: ${plugin.name}`)
  }

  const host = hostServices()
  const registered = []
  const ctx = {
    get: (service) => host.services[service],
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    effect: () => {},
  }
  const config = { bridgeRoot: '', appName: 'modal-dsh-sandboxes', defaultImage: 'python:3.13' }

  if (expectGuard) {
    let threw = false
    try {
      plugin.apply(ctx, config)
    } catch (error) {
      threw = true
      if (!String(error instanceof Error ? error.message : error).includes('tested with ^0.1.0-rc.6')) {
        throw new Error(`guard threw an unexpected error: ${String(error)}`)
      }
    }
    if (!threw) {
      throw new Error('runtime guard did not reject the incompatible dsh-tools version')
    }
    console.log(`PASS [${name}] runtime guard rejected incompatible @deepseek-ai/dsh-tools ${dshToolsVersion}`)
    rmSync(dir, { recursive: true, force: true })
    return
  }

  console.log(`[integration:${name}] calling apply(ctx, config) through the real registration path...`)
  plugin.apply(ctx, config)

  const expected = [
    'modal_sandbox_create',
    'modal_sandbox_exec',
    'modal_sandbox_exec_wait',
    'modal_sandbox_info',
    'modal_sandbox_output',
    'modal_sandbox_set_credentials',
    'modal_sandbox_terminate',
  ]
  const names = registered.map((definition) => definition.name).sort()
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`unexpected tool set registered: ${JSON.stringify(names)}`)
  }

  // Let the activation bootstrap materialize the bridge and finish its ping.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const writtenBridge = host.files.get('/ws/modal-dsh/bridge.mjs')
  if (writtenBridge !== readFileSync(packagedBridge, 'utf8')) {
    throw new Error('the plugin did not write the packaged bridge source into the workspace')
  }
  const bridgeProc = host.processes.at(-1)
  if (bridgeProc?.requests[0]?.method !== 'ping') {
    throw new Error('the plugin did not handshake with the spawned bridge')
  }

  console.log(`[integration:${name}] executing a real tool handler through the bridge protocol...`)
  bridgeProc.responses.info = { sandboxes: [] }
  const info = registered.find((definition) => definition.name === 'modal_sandbox_info')
  const result = await info.execute({}, { signal: new AbortController().signal })
  if (JSON.stringify(result) !== JSON.stringify({ sandboxes: [] })) {
    throw new Error(`unexpected canonical result: ${JSON.stringify(result)}`)
  }

  console.log(`[integration:${name}] rendering through the real output.render...`)
  const text = info.output.render({}, result).map((block) => block.text ?? '').join('\n')
  if (!text.includes('"sandboxes"')) {
    throw new Error(`render output missing the result: ${JSON.stringify(text)}`)
  }

  console.log(`PASS [${name}] packed artifact loaded, 7 tools registered, bridge bootstrapped, handler executed, render asserted`)
  rmSync(dir, { recursive: true, force: true })
}

await scenario('happy', '0.1.0-rc.6', false)
await scenario('guard', '0.1.0-rc.3', true)
