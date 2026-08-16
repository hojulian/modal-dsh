/**
 * modal-dsh — drive [Modal](https://modal.com) cloud sandboxes from a DeepSeek
 * Harness session.
 *
 * The plugin owns a long-lived `bridge.mjs` child process that hosts the Modal
 * JavaScript SDK (see bridge-host.ts for why) and exposes seven
 * `modal_sandbox_*` tools over it.
 * @module modal-dsh
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createRequire } from 'node:module'
import { BridgeHost } from './bridge-host.js'
import { resolveServices, type ServiceContext } from './services.js'
import { createTools } from './tools.js'
import { satisfiesCaret } from './version.js'

export { BridgeHost, CRED_HINT, packagedBridgeSource } from './bridge-host.js'
export { createTools } from './tools.js'

export const name = 'modal-dsh'

/** Services required by this plugin. */
export const inject = ['tools', 'fs', 'subprocess']

/** Peer range this plugin is tested against and guards at runtime. */
export const TESTED_PEER_RANGE = '^0.1.0-rc.6'

const require = createRequire(import.meta.url)

/** Resolve the dsh-tools version the plugin is actually linked against. */
export function resolvedDshToolsVersion(): string {
  try {
    const pkg = require('@deepseek-ai/dsh-tools/package.json') as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unresolved'
  }
}

/**
 * Turn a silent peer mismatch into a loud, actionable load error.
 *
 * pnpm (default config) and some npm setups can link an older RC into the
 * plugin's peer slot without failing the install (see README Troubleshooting).
 * The plugin refuses to load in that case instead of failing at runtime later.
 */
export function assertPeerCompatible(): void {
  const version = resolvedDshToolsVersion()
  if (!satisfiesCaret(version, TESTED_PEER_RANGE)) {
    throw new Error(
      `modal-dsh: resolved @deepseek-ai/dsh-tools ${version}, but this plugin is tested with `
      + `${TESTED_PEER_RANGE}. Upgrade DeepSeek Harness to 0.1.0-rc.6 or later, then reinstall this plugin. `
      + 'See the Troubleshooting section in the README.',
    )
  }
}

/** Plugin configuration supplied through cordis.yml. */
export interface Config {
  /** Directory the bridge is materialized under; defaults to the workspace root. */
  bridgeRoot: string
  /** Modal app the sandboxes are created under. */
  appName: string
  /** Image used when a create call omits one. */
  defaultImage: string
}

/** Schemastery schema with defaults. */
export const Config: Schema<Config> = Schema.object({
  bridgeRoot: Schema.string().default(''),
  appName: Schema.string().default('modal-dsh-sandboxes'),
  defaultImage: Schema.string().default('python:3.13'),
})

/**
 * Register the Modal sandbox tools and bring the bridge up.
 * @param ctx - registrant context carrying the tool registry and host services.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  assertPeerCompatible()
  const services = resolveServices(ctx as unknown as ServiceContext)
  const host = new BridgeHost(services, {
    bridgeRoot: config.bridgeRoot === '' ? undefined : config.bridgeRoot,
    appName: config.appName,
    defaultImage: config.defaultImage,
  })

  const disposers = createTools(host).map((tool) => ctx.tools.register(tool as never))
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Registry already torn down.
      }
    }
  }, 'modal-dsh: tools')
  ctx.effect(() => () => host.stop(), 'modal-dsh: bridge')

  // Bring the bridge up eagerly so the first tool call is fast, but never let a
  // bootstrap failure fail activation: every tool retries the spawn on use.
  void host.start().then(
    () => {
      console.log(`modal-dsh: ready (bridge dir ${host.bridgeDir}, creds source: ${host.credentials === null ? 'ambient/fallback' : 'explicit'})`)
    },
    (error: unknown) => {
      console.error(
        `modal-dsh: bootstrap failed (tools will retry on first use): ${error instanceof Error ? error.message : String(error)}`,
      )
    },
  )
}
