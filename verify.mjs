#!/usr/bin/env node
// Standalone regression harness for dsh-visual-memory.
//
// Covers everything that can be verified without a live DSH process:
//   1. the bundle contract the loader enforces (name / inject / apply)
//   2. the profile wiring that makes the plugin survive a restart
//   3. the pixel engine against a fixture whose colours are known exactly
//      (draw / probe / pixels / crop / compose / overlay)
//   4. the lossless-JSON invariant that once took a tool down
//   5. that stored originals still re-hash to their recorded sha256
//
// It does NOT replace calling the real tools: the host-side path
// (ctx.attachments.saveFile, ctx.fs, ctx.tools) is exercised by the agent
// end-to-end. This script says so rather than implying more coverage.
//
//   node verify.mjs        # exit 0 = all pass, exit 1 = at least one failure

import { execFile, execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const IMAGING = path.join(HERE, 'lib', 'imaging.py')
const ENTRY = path.join(HERE, 'lib', 'index.mjs')
const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-verify-'))
const results = []
const check = (name, fn) => {
  try {
    results.push({ name, ok: true, detail: fn() ?? '' })
  } catch (error) {
    results.push({ name, ok: false, detail: String(error?.message ?? error) })
  }
}

function py(request) {
  const stdout = execFileSync('python3', [IMAGING], { input: JSON.stringify(request), maxBuffer: 32 * 1024 * 1024 })
  const parsed = JSON.parse(stdout.toString())
  if (parsed.ok !== true) throw new Error(parsed.error)
  return parsed.value
}

try {
  // -------------------------------------------------------------- 1. contract
  const mod = await import(ENTRY)
  check('bundle contract: name / inject / apply', () => {
    assert.equal(mod.name, 'visual-memory')
    assert.deepEqual([...mod.inject].sort(), ['attachments', 'fs', 'systemPrompt', 'tools', 'webServer'])
    assert.equal(typeof mod.apply, 'function')
    return 'name=' + mod.name + ' inject=' + JSON.stringify(mod.inject)
  })

  const patch = fs.readFileSync(path.join(HERE, 'cordis.patch.yml'), 'utf8')
  check('patch row matches the module inject list', () => {
    const declared = [...patch.matchAll(/^\s+- (\w+)$/gm)].map((m) => m[1]).sort()
    assert.deepEqual(declared, ['attachments', 'fs', 'systemPrompt', 'tools', 'webServer'])
    assert.match(patch, /id: visual-memory/)
    assert.match(patch, /name: 'dsh-visual-memory'/)
    return 'cordis.patch.yml declares the same 5 services'
  })

  // --------------------------------------------------------------- 2. wiring
  check('profiles/web wires the bundle for restart', () => {
    const profile = path.join(HOME, 'profiles', 'web')
    const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
    assert.ok(pkg.dependencies['dsh-visual-memory'], 'dependency missing')
    assert.ok(pkg.dsh.profile.bundles.includes('dsh-visual-memory'), 'bundles entry missing')
    assert.ok(fs.existsSync(path.join(profile, 'node_modules', 'dsh-visual-memory')), 'node_modules link missing')
    return 'dependency + bundles entry + node_modules link all present'
  })

  // --------------------------------------------------------- 3. pixel engine
  const source = path.join(work, 'fixture.png')
  const fixture = py({ op: 'draw', path: source })
  check('fixture has the exact authored geometry', () => {
    assert.equal(fixture.width, 64)
    assert.equal(fixture.height, 32)
    assert.deepEqual(fixture.quadrants, ['#ff0000', '#00ff00', '#0000ff', '#ffffff'])
    return '64x32, four known quadrant colours'
  })

  check('probe reports dimensions and a 64-bit dHash', () => {
    const probed = py({ op: 'probe', path: source })
    assert.equal(probed.width, 64)
    assert.equal(probed.height, 32)
    assert.match(probed.dhash, /^[0-9a-f]{16}$/)
    return `${probed.width}x${probed.height} dHash=${probed.dhash} format=${probed.format}`
  })

  check('read_pixels 2x2 reads exactly the authored quadrants', () => {
    const pixels = py({ op: 'pixels', path: source, rows: 2, cols: 2 })
    assert.deepEqual(pixels.cells, [['#ff0000', '#00ff00'], ['#0000ff', '#ffffff']])
    assert.equal(pixels.distinctCount, 4)
    return JSON.stringify(pixels.cells)
  })

  check('crop + enlarge preserves the sampled colour', () => {
    const cropped = py({
      op: 'crop',
      path: source,
      output: path.join(work, 'crop.png'),
      region: { x1: 0, y1: 0, x2: 32, y2: 16 },
      scale: 2,
    })
    assert.equal(cropped.width, 64)
    assert.equal(cropped.height, 32)
    const reread = py({ op: 'pixels', path: cropped.output, rows: 1, cols: 1 })
    assert.deepEqual(reread.cells, [['#ff0000']])
    return `region -> ${cropped.width}x${cropped.height}, centre still #ff0000`
  })

  check('compose lays two panels out side by side', () => {
    const composed = py({
      op: 'compose',
      output: path.join(work, 'sheet.png'),
      items: [{ path: source }, { path: source }],
      mode: 'side-by-side',
      labels: ['left', 'right'],
    })
    assert.equal(composed.columns, 2)
    assert.equal(composed.rows, 1)
    assert.ok(composed.width > 64, 'sheet should be wider than one panel')
    return `${composed.width}x${composed.height}`
  })

  check('overlay clamps negative and oversized boxes to the frame', () => {
    const clipped = py({
      op: 'overlay',
      path: source,
      output: path.join(work, 'overlay.png'),
      regions: [{ x1: -50, y1: -50, x2: 9999, y2: 9999, label: 'ALL' }],
    })
    assert.deepEqual(clipped.regions[0], { x1: 0, y1: 0, x2: 64, y2: 32, label: 'ALL' })
    return 'clamped to 0,0,64,32'
  })

  // ------------------------------------------------------ 4. lossless-JSON rule
  const sourceText = fs.readFileSync(ENTRY, 'utf8')
  check('every tool result passes through jsonSafe', () => {
    const bare = [...sourceText.matchAll(/\n {6}return \{\n/g)].length
    assert.equal(bare, 0, bare + ' bare `return {` left in a tool body')
    const wrapped = [...sourceText.matchAll(/return jsonSafe\(\{/g)].length
    assert.ok(wrapped >= 7, 'expected at least 7 guarded returns, saw ' + wrapped)
    return wrapped + ' guarded returns, 0 bare'
  })

  // ------------------------------------------------------------ 5. losslessness
  check('stored originals re-hash to their recorded sha256', () => {
    const indexPath = process.argv[2] ?? path.join(process.cwd(), '.dsh-visual-memory', 'index.jsonl')
    if (!fs.existsSync(indexPath)) return 'skipped: no index at ' + indexPath
    const seen = new Set()
    let verified = 0
    let missing = 0
    for (const line of fs.readFileSync(indexPath, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const record = JSON.parse(line)
      if (seen.has(record.id)) continue
      seen.add(record.id)
      if (!record.originalHostPath || !fs.existsSync(record.originalHostPath)) {
        missing += 1
        continue
      }
      const digest = crypto.createHash('sha256').update(fs.readFileSync(record.originalHostPath)).digest('hex')
      assert.equal(digest, record.sha256, 'stored bytes changed for ' + record.id)
      verified += 1
    }
    assert.equal(missing, 0, missing + ' indexed originals are missing from disk')
    return verified + ' originals re-hashed byte-identical'
  })
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log((entry.ok ? 'PASS  ' : 'FAIL  ') + entry.name + (entry.detail ? '\n        ' + entry.detail : ''))
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed')
process.exit(failed === 0 ? 0 : 1)
