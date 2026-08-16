#!/usr/bin/env node
/**
 * Assemble the contents of the `release` branch into ./release-branch.
 *
 * `main` carries TypeScript source only, so `pnpm add github:hojulian/modal-dsh`
 * would have to run the `prepare` build in the consumer's environment — which
 * pnpm 10 blocks for git-hosted packages (ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED).
 * The `release` branch is the git-installable form: prebuilt `lib/`, and a
 * package.json with no lifecycle scripts so pnpm has nothing to build.
 *
 * The file set comes from `pnpm pack`, so it always matches the `files` field
 * in package.json rather than a second list that can drift.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'release-branch')
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim()

const staging = mkdtempSync(path.join(tmpdir(), 'modal-dsh-release-'))
run('pnpm', ['pack', '--pack-destination', staging])

const tarball = readdirSync(staging).find((f) => f.endsWith('.tgz'))
if (!tarball) throw new Error('pnpm pack produced no tarball in ' + staging)
run('tar', ['-xzf', path.join(staging, tarball)], staging)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(path.dirname(outDir), { recursive: true })
renameSync(path.join(staging, 'package'), outDir)
rmSync(staging, { recursive: true, force: true })

// Strip everything that would make pnpm treat this as a package needing a
// build: any lifecycle script (pnpm triggers on prepare/prepack/prepublish*)
// and the devDependencies those scripts needed.
const pkgPath = path.join(outDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
delete pkg.scripts
delete pkg.devDependencies
delete pkg.files
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

console.log('[release] assembled ' + outDir + ' from ' + tarball)
console.log('[release] ' + readdirSync(outDir).join(' '))
