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
const check = async (name, fn) => {
  try {
    const detail = (await fn()) ?? ''
    results.push({ name, ok: true, skipped: /^skipped:/.test(detail), detail })
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
  await check('bundle contract: name / inject / apply', () => {
    assert.equal(mod.name, 'visual-memory')
    assert.deepEqual([...mod.inject].sort(), ['attachments', 'connection', 'fs', 'systemPrompt', 'tools', 'webServer'])
    assert.equal(typeof mod.apply, 'function')
    return 'name=' + mod.name + ' inject=' + JSON.stringify(mod.inject)
  })

  const patch = fs.readFileSync(path.join(HERE, 'cordis.patch.yml'), 'utf8')
  await check('patch row matches the module inject list', () => {
    const declared = [...patch.matchAll(/^\s+- (\w+)$/gm)].map((m) => m[1]).sort()
    assert.deepEqual(declared, ['attachments', 'connection', 'fs', 'systemPrompt', 'tools', 'webServer'])
    assert.match(patch, /id: visual-memory/)
    assert.match(patch, /name: '@xiciyang\/dsh-visual-memory'/)
    return 'cordis.patch.yml declares the same 6 services'
  })

  // --------------------------------------------------------------- 2. wiring
  await check('profiles/web wires the bundle for restart', () => {
    const profile = path.join(HOME, 'profiles', 'web')
    // CI has no DSH profile: report the skip instead of failing on the host's state.
    if (!fs.existsSync(profile)) return 'skipped: no profiles/web under this DSH_HOME' 
    const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
    assert.ok(pkg.dependencies['@xiciyang/dsh-visual-memory'], 'dependency missing')
    assert.ok(pkg.dsh.profile.bundles.includes('@xiciyang/dsh-visual-memory'), 'bundles entry missing')
    assert.ok(fs.existsSync(path.join(profile, 'node_modules', '@xiciyang', 'dsh-visual-memory')), 'node_modules link missing')
    return 'dependency + bundles entry + node_modules link all present'
  })

  // --------------------------------------------------------- 3. pixel engine
  const source = path.join(work, 'fixture.png')
  const fixture = py({ op: 'draw', path: source })
  await check('fixture has the exact authored geometry', () => {
    assert.equal(fixture.width, 64)
    assert.equal(fixture.height, 32)
    assert.deepEqual(fixture.quadrants, ['#ff0000', '#00ff00', '#0000ff', '#ffffff'])
    return '64x32, four known quadrant colours'
  })

  await check('probe reports dimensions and a 64-bit dHash', () => {
    const probed = py({ op: 'probe', path: source })
    assert.equal(probed.width, 64)
    assert.equal(probed.height, 32)
    assert.match(probed.dhash, /^[0-9a-f]{16}$/)
    return `${probed.width}x${probed.height} dHash=${probed.dhash} format=${probed.format}`
  })

  await check('read_pixels 2x2 reads exactly the authored quadrants', () => {
    const pixels = py({ op: 'pixels', path: source, rows: 2, cols: 2 })
    assert.deepEqual(pixels.cells, [['#ff0000', '#00ff00'], ['#0000ff', '#ffffff']])
    assert.equal(pixels.distinctCount, 4)
    return JSON.stringify(pixels.cells)
  })

  await check('crop + enlarge preserves the sampled colour', () => {
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

  await check('compose lays two panels out side by side', () => {
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

  await check('overlay clamps negative and oversized boxes to the frame', () => {
    const clipped = py({
      op: 'overlay',
      path: source,
      output: path.join(work, 'overlay.png'),
      regions: [{ x1: -50, y1: -50, x2: 9999, y2: 9999, label: 'ALL' }],
    })
    assert.deepEqual(clipped.regions[0], { x1: 0, y1: 0, x2: 64, y2: 32, label: 'ALL' })
    return 'clamped to 0,0,64,32'
  })

  // ------------------------------- 3b. gallery/raw: trust fence + path fence
  // The route is browser-reachable, so these are the security seam: refuse an
  // untrusted caller, refuse a caller-named store root, and never let `v` read
  // a path the store did not write. Each case asserts on the bytes, not just
  // the status, because a 200 is the only way a secret could escape.
  {
    const store = path.join(work, 'store')
    const artifacts = path.join(store, 'artifacts')
    const dshHome = path.join(work, 'dsh-home')
    fs.mkdirSync(artifacts, { recursive: true })
    fs.mkdirSync(dshHome, { recursive: true })
    const original = path.join(work, 'original.png')
    fs.copyFileSync(source, original)
    const overlay = path.join(artifacts, 'overlay.png')
    fs.copyFileSync(source, overlay)
    const secret = path.join(work, 'secret.txt')
    fs.writeFileSync(secret, 'TOP-SECRET-DO-NOT-SERVE')
    const escape = path.join(artifacts, 'escape.png')
    let symlinked = true
    try {
      fs.symlinkSync(secret, escape)
    } catch {
      symlinked = false
    }
    const record = {
      v: 1,
      id: 'VM-test',
      sha256: 'a'.repeat(64),
      format: 'png',
      bytes: fs.statSync(source).size,
      width: 64,
      height: 32,
      dhash: '0'.repeat(16),
      originalHostPath: original,
      // The index itself lists an arbitrary path and a symlink as variants:
      // being listed is necessary but must not be sufficient.
      overlays: symlinked ? [secret, escape, overlay] : [secret, overlay],
      composites: [],
      rois: [],
      tags: [],
      note: '',
      text: '',
    }
    fs.writeFileSync(path.join(store, 'index.jsonl'), JSON.stringify(record) + '\n', 'utf8')
    fs.writeFileSync(path.join(dshHome, 'visual-memory-roots.json'), JSON.stringify([{ root: store }]), 'utf8')

    const savedHome = process.env.DSH_HOME
    const savedCwd = process.cwd()
    process.env.DSH_HOME = dshHome
    process.chdir(work)
    const routes = []
    const tools = []
    const fakeCtx = {
      effect: (fn) => fn(),
      systemPrompt: { section: (value) => value },
      tools: { register: (tool) => (tools.push(tool), tool) },
      webServer: { register: (route) => (routes.push(route), route) },
      connection: { requestRejection: (req) => (req.headers?.['x-test-untrusted'] === '1' ? 403 : undefined) },
      get: () => undefined,
    }
    mod.apply(fakeCtx)
    const route = routes.find((entry) => entry.path === '/_dsh/visual-memory')
    const call = async (query, headers = {}) => {
      const res = {
        status: 0,
        headers: {},
        body: undefined,
        writeHead(status, sent) {
          this.status = status
          this.headers = sent ?? {}
          return this
        },
        end(body) {
          this.body = body
        },
      }
      await route.handler({ url: '/_dsh/visual-memory' + query, headers }, res)
      return res
    }
    const text = (res) => (Buffer.isBuffer(res.body) ? res.body.toString('hex') : String(res.body ?? ''))

    try {
      await check('raw route: an untrusted request is refused before any bytes', async () => {
        const res = await call('/gallery', { 'x-test-untrusted': '1' })
        assert.equal(res.status, 403)
        assert.equal(res.body, undefined)
        return '403, empty body'
      })

      await check('gallery: a trusted request still renders the store', async () => {
        const res = await call('/gallery')
        assert.equal(res.status, 200)
        assert.match(text(res), /VM-test/)
        return '200, entry listed'
      })

      await check('raw route: a caller-named root is refused', async () => {
        const res = await call('/gallery?root=' + encodeURIComponent(path.dirname(secret)))
        assert.equal(res.status, 400)
        return '400 unknown store root'
      })

      await check('raw route: v=<arbitrary path> cannot read outside the store', async () => {
        for (const candidate of [secret, escape, '/etc/passwd', original]) {
          const res = await call('/raw?id=VM-test&v=' + encodeURIComponent(candidate))
          assert.notEqual(res.status, 200, 'served ' + candidate)
          assert.ok(!text(res).includes(Buffer.from('TOP-SECRET').toString('hex')), 'leaked secret bytes')
        }
        return 'secret, symlink, /etc/passwd and a non-listed original are all refused'
      })

      await check('raw route: the archived original is still served verbatim', async () => {
        const res = await call('/raw?id=VM-test')
        assert.equal(res.status, 200)
        assert.deepEqual(Buffer.from(res.body), fs.readFileSync(original))
        return 'bytes identical to the archived original'
      })

      await check('raw route: a store-written overlay is served, by name only', async () => {
        const res = await call('/raw?id=VM-test&v=' + encodeURIComponent(overlay))
        assert.equal(res.status, 200)
        assert.deepEqual(Buffer.from(res.body), fs.readFileSync(overlay))
        return 'listed + inside artifacts/ => 200'
      })
    } finally {
      process.chdir(savedCwd)
      if (savedHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedHome
    }
  }

  // ------------------------------------------------------ 4. lossless-JSON rule
  const sourceText = fs.readFileSync(ENTRY, 'utf8')
  await check('every tool result passes through jsonSafe', () => {
    const bare = [...sourceText.matchAll(/\n {6}return \{\n/g)].length
    assert.equal(bare, 0, bare + ' bare `return {` left in a tool body')
    const wrapped = [...sourceText.matchAll(/return jsonSafe\(\{/g)].length
    assert.ok(wrapped >= 7, 'expected at least 7 guarded returns, saw ' + wrapped)
    return wrapped + ' guarded returns, 0 bare'
  })

  // ------------------------------------------------------------ 5. losslessness
  await check('stored originals re-hash to their recorded sha256', () => {
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
