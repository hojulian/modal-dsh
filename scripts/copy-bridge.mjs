#!/usr/bin/env node
/**
 * Copy the runtime bridge next to the compiled output.
 *
 * `src/bridge.mjs` is not TypeScript and must ship verbatim: the plugin reads
 * `lib/bridge.mjs` at apply time and writes it into the workspace bridge dir,
 * where node runs it directly against the installed Modal SDK.
 */

import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(path.join(root, 'lib'), { recursive: true })
copyFileSync(path.join(root, 'src', 'bridge.mjs'), path.join(root, 'lib', 'bridge.mjs'))
console.log('[build] copied src/bridge.mjs -> lib/bridge.mjs')
