// dsh-visual-memory — lossless visual memory, explicit attention, side-by-side
// comparison, and on-demand retrieval for a DSH agent.
//
// Why this exists (measured baseline, 2026-10-04): this profile already had
// native multimodal input (`read_image` works: a randomised ground-truth image
// was read back exactly), a browser toolchain, and the dsh-vision-toolkit
// (glance / ground / detect / crop / pixel_diff / OCR). What it did NOT have:
//
//   * visual memory — images were consumed per turn and never addressable
//     again; the attachment store dedupes by content but exposes no index, no
//     tags, no text, no "which image was that?" retrieval;
//   * an attention ledger — vision_ground produces a box and then forgets it;
//     nothing records which regions of one image were ever examined, and
//     nothing *draws* a model-chosen box back onto the image so a human can
//     see what the agent looked at;
//   * a labelled comparison sheet — vision_pixel_diff owns the numeric diff,
//     but there was no composite that puts several images next to each other
//     with captions for the model or the human to read in one glance;
//   * a capability answer for the hybrid case — with a text-only model in the
//     route, "can this model see?" was an assumption rather than a fact.
//
// Ownership boundaries (deliberate, so no capability has two owners):
//   * bytes                -> ctx.attachments.saveFile  (verbatim, content-addressed)
//   * crop / diff / colour -> dsh-vision-toolkit (vision_crop, vision_pixel_diff, ...)
//   * OCR / caption / QA   -> dsh-vision-toolkit (vision_glance)
//   * index / ROI ledger / labelled composite / capability probe -> here

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'visual-memory'

// `connection` is the composition's trust + browser-authentication service. The
// gallery/raw HTTP route is not an Agent context, so it must ask that service
// for a rejection before it reveals any bytes (see the route at the bottom).
export const inject = ['tools', 'attachments', 'webServer', 'fs', 'systemPrompt', 'connection']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const IMAGING = path.join(HERE, 'imaging.py')
const STORE_DIRNAME = '.dsh-visual-memory'
const INDEX_FILE = 'index.jsonl'
const MAX_IMAGE_BYTES = 64 * 1024 * 1024

// ---------------------------------------------------------------- utilities

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) }]
}

/**
 * Tool output must be lossless JSON: one `undefined` key rejects the whole
 * call ("value is not lossless JSON"). Make that structural rather than a
 * discipline — every tool result passes through here, so a conditional field
 * can never take a tool down again.
 */
function jsonSafe(value) {
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = jsonSafe(entry)
    }
    return out
  }
  return value
}

// `ctx.tools.register` stores `parameters` verbatim (unlike `defineTool`, which
// compiles it), so an author-style property map reaches the provider without a
// top-level `type: "object"` and the request is rejected with
// `schema must be a JSON Schema of 'type: "object"', got 'type: null'`.
// `defineTool` is not importable from this bundle (no local node_modules), so
// compile the implicit parameter root here: hoist per-property `required: true`
// into the schema's `required` array and leave every nested node unchanged.
function compiledParameters(spec) {
  const properties = {}
  const required = []
  for (const [name, node] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = node
    properties[name] = rest
    if (isRequired === true) required.push(name)
  }
  return required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties }
}

function sessionCwd(exec) {
  const fromSession = exec?.agent?.session?.header?.cwd
  if (typeof fromSession === 'string' && fromSession.length > 0) return fromSession
  const fromOptions = exec?.agent?.options?.cwd
  if (typeof fromOptions === 'string' && fromOptions.length > 0) return fromOptions
  return process.cwd()
}

function storeRoot(exec) {
  return path.join(sessionCwd(exec), STORE_DIRNAME)
}

/**
 * The gallery route is served over HTTP with no Agent context, so it cannot
 * derive the session workspace the way a tool call can. Every tool call
 * publishes its store root here; the gallery defaults to the most recently
 * used one and can switch between all known roots.
 */
function registryPath() {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home !== '' ? home : process.cwd()
  return path.join(base, 'visual-memory-roots.json')
}

async function rememberRoot(root) {
  try {
    const file = registryPath()
    let roots = []
    try {
      roots = JSON.parse(await fs.readFile(file, 'utf8'))
      if (!Array.isArray(roots)) roots = []
    } catch {
      roots = []
    }
    const next = [{ root, at: new Date().toISOString() }, ...roots.filter((entry) => entry?.root !== root)].slice(0, 20)
    await fs.writeFile(file, JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // Losing the gallery hint must never fail a memory operation.
  }
}

async function knownRoots() {
  try {
    const parsed = JSON.parse(await fs.readFile(registryPath(), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry?.root === 'string') : []
  } catch {
    return []
  }
}

/**
 * Resolve the `v` query of the raw route to a path it is allowed to read.
 *
 * `original` (or no `v`) is the verbatim archived image. Any other value must
 * already be listed by the record as one of its own overlays/composites — that
 * is, a file this plugin wrote — and its real path must still resolve inside
 * this store's `artifacts/` directory. A caller-supplied filesystem path is
 * never accepted, so the route cannot become an arbitrary-file read.
 *
 * @param record - one index entry.
 * @param variant - raw `v` query, or null when absent.
 * @param root - the store root this route is serving.
 * @returns the absolute path to read, or undefined when the variant is refused.
 */
async function rawTargetFor(record, variant, root) {
  if (variant === null || variant === '' || variant === 'original') {
    return typeof record.originalHostPath === 'string' && record.originalHostPath !== ''
      ? record.originalHostPath
      : undefined
  }
  const listed = [...(record.overlays || []), ...(record.composites || [])]
  if (!listed.includes(variant)) return undefined
  const artifacts = path.join(root, 'artifacts')
  let realArtifacts
  let realTarget
  try {
    realArtifacts = await fs.realpath(artifacts)
    realTarget = await fs.realpath(variant)
  } catch {
    // A missing file, or a symlink pointing nowhere, is refused rather than
    // followed: the question is where the bytes really are, not what the name says.
    return undefined
  }
  const rel = path.relative(realArtifacts, realTarget)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  return realTarget
}

function runPython(request) {
  return new Promise((resolve, reject) => {
    const child = execFile('python3', [IMAGING], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error('imaging engine failed: ' + error.message + (stderr ? ' :: ' + stderr.slice(0, 400) : '')))
        return
      }
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch (parseError) {
        reject(new Error('imaging engine returned non-JSON: ' + stdout.slice(0, 200)))
        return
      }
      if (parsed.ok !== true) {
        reject(new Error('imaging engine: ' + parsed.error))
        return
      }
      resolve(parsed.value)
    })
    child.stdin.end(JSON.stringify(request))
  })
}

/** Append-only index: one JSON object per line, folded by id (last write wins). */
async function loadRecords(root) {
  let raw
  try {
    raw = await fs.readFile(path.join(root, INDEX_FILE), 'utf8')
  } catch {
    return []
  }
  const byId = new Map()
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const record = JSON.parse(trimmed)
      if (record && typeof record.id === 'string') byId.set(record.id, record)
    } catch {
      // A torn last line is expected after a hard kill; skip it rather than
      // losing the whole index.
    }
  }
  return [...byId.values()]
}

async function appendRecord(root, record) {
  await fs.mkdir(root, { recursive: true })
  await fs.appendFile(path.join(root, INDEX_FILE), JSON.stringify(record) + '\n', 'utf8')
}

function vmIdFor(sha256) {
  return 'VM-' + sha256.slice(0, 10)
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/**
 * The session's own position, read from its durable event log: how many turns
 * and steps have started. This is the DSH analogue of VISTA's (turn, frame)
 * index and is what makes "retrieve a frame from an earlier turn" meaningful.
 */
function turnProvenance(exec) {
  try {
    const session = exec?.agent?.session
    if (session === undefined) return { turn: null, step: null }
    const events = typeof session.snapshotEvents === 'function'
      ? session.snapshotEvents()
      : (Array.isArray(session.events) ? session.events : [])
    let turn = 0
    let step = 0
    for (const event of events) {
      if (event?.type === 'turn/start') turn += 1
      else if (event?.type === 'step/start') step += 1
    }
    return { turn: turn > 0 ? turn : null, step: step > 0 ? step : null }
  } catch {
    return { turn: null, step: null }
  }
}

function hammingHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return 64
  let value = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = parseInt(left[index], 16)
    const b = parseInt(right[index], 16)
    let xor = a ^ b
    while (xor) {
      value += xor & 1
      xor >>= 1
    }
  }
  return value
}

async function resolveHostPath(ctx, exec, input) {
  const cwd = sessionCwd(exec)
  const target = await ctx.fs.resolve(input, { cwd, signal: exec?.signal })
  const hostPath = ctx.fs.processPath(target)
  if (typeof hostPath !== 'string' || hostPath === '') {
    throw new Error('could not resolve a host path for ' + input)
  }
  return { hostPath, cwd }
}

/** Store bytes verbatim in the host attachment store: the lossless copy. */
async function storeVerbatim(ctx, bytes, label) {
  const ref = await ctx.attachments.saveFile({ data: bytes, name: label })
  const hostPath = ctx.attachments.fileHostPath(ref)
  if (typeof hostPath !== 'string' || hostPath === '') {
    throw new Error('attachment store is not host-file backed; cannot expose the lossless original')
  }
  return { ref, hostPath }
}

/**
 * The same capability probe the native read_image tool applies: resolve the
 * session's exact routed provider/model and require it to declare image input.
 * This is the hybrid-model answer, and it is a fact rather than an assumption.
 */
async function routeCapability(ctx, exec) {
  const llm = ctx.get('llm')
  const routed = exec?.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec?.agent?.options?.provider
  const model = routed?.model ?? exec?.agent?.options?.model
  if (llm === undefined) return { resolved: false, reason: 'llm service unavailable' }
  if (provider === undefined || model === undefined) {
    return { resolved: false, reason: 'the current model route could not be resolved' }
  }
  try {
    const info = await llm.resolveModelInfo(provider, model, exec?.signal)
    const modalities = info?.inputModalities
    const list = Array.isArray(modalities) ? modalities : null
    return {
      resolved: true,
      provider,
      model,
      inputModalities: list,
      nativeImageInput: list !== null && list.includes('image'),
      recommendation:
        list !== null && list.includes('image')
          ? 'native: attach the stored image with read_image (lossless original path is returned by every tool here)'
          : 'bridged: this route declares no image input — route pixels through vision_glance/vision_long_screenshot_ocr and rely on the indexed text',
    }
  } catch (error) {
    return { resolved: false, reason: 'resolveModelInfo failed: ' + String(error?.message ?? error) }
  }
}

function visionToolState(ctx, exec) {
  const required = [
    'vision_glance',
    'vision_ground',
    'vision_detect',
    'vision_crop',
    'vision_pixel_diff',
    'vision_long_screenshot_ocr',
    'vision_dominant_colors',
    'vision_trace',
    'vision_html_screenshot',
  ]
  // dsh-vision-toolkit registers its visual tools into the AGENT scope, and the
  // tools registry scopes a query by passing the Agent itself
  // (`ctx.tools.schemas(agent)` — the same call the Cordis Inspect Tool
  // provider makes). Querying without a scope returns only the global
  // registrations, which is why an earlier version of this report claimed the
  // visual tools were missing while they were in fact callable.
  const attempts = []
  if (exec?.agent !== undefined) attempts.push(['agent', exec.agent])
  attempts.push(['global', undefined])
  let names = []
  let scope = 'unavailable'
  for (const [label, scopeKey] of attempts) {
    try {
      const schemas = scopeKey === undefined ? ctx.tools.schemas() : ctx.tools.schemas(scopeKey)
      names = (Array.isArray(schemas) ? schemas : [])
        .map((entry) => entry?.name)
        .filter((value) => typeof value === 'string')
      scope = label
      if (names.some((value) => required.includes(value))) break
    } catch {
      // fall through to the next attempt
    }
  }
  if (scope === 'unavailable') {
    return { available: false, present: [], missing: required, scope, reason: 'tool registry unreadable' }
  }
  const present = required.filter((value) => names.includes(value))
  return {
    available: present.length === required.length,
    scope,
    toolCount: names.length,
    present,
    missing: required.filter((value) => !names.includes(value)),
  }
}

async function entryForPath(ctx, exec, input, options = {}) {
  const { hostPath, cwd } = await resolveHostPath(ctx, exec, input)
  const bytes = new Uint8Array(await fs.readFile(hostPath))
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('image exceeds ' + MAX_IMAGE_BYTES + ' bytes: ' + hostPath)
  const root = storeRoot(exec)
  await rememberRoot(root)
  const records = await loadRecords(root)
  const sha256 = sha256Hex(bytes)
  const existing = records.find((record) => record.sha256 === sha256)
  if (existing !== undefined) {
    return { record: existing, hostPath, root, deduplicated: true, cwd }
  }
  const probe = await runPython({ op: 'probe', path: hostPath })
  const { ref, hostPath: storedPath } = await storeVerbatim(ctx, bytes, path.basename(hostPath))
  // VISTA indexes every archived frame by (turn, frame). The DSH analogue is
  // the session's own turn/step counters plus a monotonic per-session sequence,
  // so an observation can be retrieved "across time" and replayed in order.
  const provenance = turnProvenance(exec)
  const sessionId = String(exec?.agent?.session?.id ?? '')
  const seq = records.filter((entry) => entry.sessionId === sessionId).length + 1
  const record = {
    v: 1,
    id: vmIdFor(sha256),
    attachmentId: String(ref.attachmentId),
    attachmentName: ref.name,
    sourcePath: hostPath,
    originalHostPath: storedPath,
    sha256,
    bytes: bytes.byteLength,
    width: probe.width,
    height: probe.height,
    format: probe.format,
    mode: probe.mode,
    dhash: probe.dhash,
    turn: provenance.turn,
    step: provenance.step,
    seq,
    tags: Array.isArray(options.tags) ? options.tags.map(String) : [],
    note: typeof options.note === 'string' ? options.note : '',
    text: typeof options.text === 'string' ? options.text : '',
    rois: [],
    overlays: [],
    composites: [],
    createdAt: new Date().toISOString(),
    sessionId: String(exec?.agent?.session?.id ?? ''),
    cwd,
  }
  await appendRecord(root, record)
  return { record, hostPath, root, deduplicated: false, cwd }
}

function scoreRecord(record, query) {
  const needle = query.toLowerCase()
  let score = 0
  const fields = [
    [record.id, 6],
    [record.note, 5],
    [record.text, 5],
    [(record.tags || []).join(' '), 4],
    [record.sourcePath, 3],
    [record.sha256, 8],
    [record.dhash, 8],
  ]
  for (const [value, weight] of fields) {
    if (typeof value === 'string' && value.toLowerCase().includes(needle)) score += weight
  }
  return score
}

function publicEntry(record) {
  return {
    id: record.id,
    sha256: record.sha256,
    dhash: record.dhash,
    width: record.width,
    height: record.height,
    format: record.format,
    bytes: record.bytes,
    tags: record.tags || [],
    note: record.note || '',
    text: record.text || '',
    rois: record.rois || [],
    overlays: record.overlays || [],
    composites: record.composites || [],
    sourcePath: record.sourcePath,
    originalHostPath: record.originalHostPath,
    createdAt: record.createdAt,
    attachmentId: record.attachmentId,
    turn: record.turn,
    step: record.step,
    seq: record.seq,
    storedAt: record.createdAt,
  }
}

// ------------------------------------------------------------------- gallery

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function galleryHtml(records, capability, vision, root, roots = []) {
  const switcher = roots.length > 1
    ? '<div class="bar">' + roots.map((entry) =>
        '<a class="pill' + (entry.root === root ? ' ok' : '') + '" href="/_dsh/visual-memory/gallery?root=' +
        encodeURIComponent(entry.root) + '">' + escapeHtml(entry.root) + '</a>').join('') + '</div>'
    : ''
  const cards = records
    .slice()
    .reverse()
    .map((record) => {
      const rois = (record.rois || [])
        .map((roi) => 'R' + escapeHtml(roi.label || '') + ' (' + roi.x1 + ',' + roi.y1 + ',' + roi.x2 + ',' + roi.y2 + ')')
        .join(' · ')
      const overlays = (record.overlays || []).length
      const href = '/_dsh/visual-memory/raw?id=' + encodeURIComponent(record.id)
      // Build each part as its own value. A mixed `a + b ? x : y` chain used to
      // live here, and `?:` binds looser than `+`, so the whole prefix became
      // the condition and every card silently lost its markup.
      const parts = []
      parts.push('<article class="card">')
      parts.push('<a class="thumb" href="' + href + '" target="_blank">')
      parts.push('<img loading="lazy" src="' + href + '" alt="' + escapeHtml(record.id) + '"></a>')
      parts.push('<div class="meta">')
      parts.push('<div class="id">' + escapeHtml(record.id) + '</div>')
      parts.push('<div class="dims">' + record.width + '×' + record.height + ' · ' + escapeHtml(record.format) + ' · ' + Math.round(record.bytes / 1024) + ' KB</div>')
      if ((record.tags || []).length > 0) {
        parts.push('<div class="tags">' + (record.tags || []).map((tag) => '<span>' + escapeHtml(tag) + '</span>').join('') + '</div>')
      }
      if (record.note) parts.push('<div class="note">' + escapeHtml(record.note) + '</div>')
      if (record.text) parts.push('<div class="ocr">' + escapeHtml(String(record.text).slice(0, 260)) + '</div>')
      if (rois) parts.push('<div class="rois">attention: ' + rois + '</div>')
      if (overlays > 0) parts.push('<div class="rois">' + overlays + ' attention overlay(s)</div>')
      parts.push('<div class="hash">sha256 ' + escapeHtml(record.sha256.slice(0, 16)) + '… · dHash ' + escapeHtml(record.dhash) + '</div>')
      parts.push('<div class="path">' + escapeHtml(record.originalHostPath) + '</div>')
      parts.push('</div></article>')
      return parts.join('')
    })
    .join('')

  return (
    '<!doctype html><html lang="zh"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Visual memory</title><style>' +
    ':root{color-scheme:light dark}' +
    'body{margin:0;padding:24px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#faf9f7;color:#1c1b19}' +
    'h1{font-size:20px;margin:0 0 4px}' +
    '.sub{color:#6b6862;margin-bottom:18px}' +
    '.bar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}' +
    '.pill{background:#fff;border:1px solid #e3e0da;border-radius:999px;padding:4px 12px;font-size:12px}' +
    '.pill.ok{border-color:#9ccf9c;background:#f2fbf2}.pill.warn{border-color:#e5c07b;background:#fdf7e8}' +
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}' +
    '.card{background:#fff;border:1px solid #e8e5df;border-radius:12px;overflow:hidden;display:flex;flex-direction:column}' +
    '.thumb{display:block;background:#f0eee9;aspect-ratio:16/10;overflow:hidden}' +
    '.thumb img{width:100%;height:100%;object-fit:contain;display:block}' +
    '.meta{padding:10px 12px;display:flex;flex-direction:column;gap:4px}' +
    '.id{font-weight:600}.dims,.hash,.path{color:#7a766f;font-size:11px;word-break:break-all}' +
    '.tags span{display:inline-block;background:#eef2ff;color:#3742a8;border-radius:6px;padding:1px 6px;margin-right:4px;font-size:11px}' +
    '.note{font-size:12px;color:#3c3a36}.ocr{font-size:12px;color:#4a4742;background:#f7f6f3;border-radius:6px;padding:6px;white-space:pre-wrap}' +
    '.rois{font-size:11px;color:#a1442c}' +
    '.empty{color:#6b6862;padding:32px;text-align:center;border:1px dashed #d8d4cc;border-radius:12px}' +
    '</style></head><body>' +
    '<h1>Visual memory</h1>' +
    '<div class="sub">无损视觉记忆 · 显式注意力 · 并排对比 · 按需检索 — store: ' + escapeHtml(root) + '</div>' +
    switcher +
    '<div class="bar">' +
    '<span class="pill">' + records.length + ' entries</span>' +
    (capability.resolved === true
      ? '<span class="pill ' + (capability.nativeImageInput ? 'ok' : 'warn') + '">route: ' + escapeHtml(capability.model || '?') + ' — ' + (capability.nativeImageInput ? 'native image input' : 'text-only (bridged)') + '</span>'
      : '<span class="pill warn">route: not measurable from the Web seam — call <code>visual_memory_status</code> for the per-agent answer</span>') +
    (vision.scope === 'agent'
      ? '<span class="pill ' + (vision.available ? 'ok' : 'warn') + '">vision tools: ' + vision.present.length + '/' + (vision.present.length + vision.missing.length) + '</span>'
      : '<span class="pill warn">vision tools: per-agent (not visible from the Web seam)</span>') +
    '</div>' +
    (records.length === 0 ? '<div class="empty">还没有任何视觉记忆。调用 <code>visual_remember</code> 存入第一张图。</div>' : '<div class="grid">' + cards + '</div>') +
    '</body></html>'
  )
}

// --------------------------------------------------------------------- apply

export function apply(ctx) {
  // -------- standing discipline (so the capability is used, not just present)
  const section = [
    '## 视觉记忆纪律（dsh-visual-memory 常驻）',
    '',
    '1. **先存再问。** 值得回看的图（截图/设计稿/图表/UI 证据）先 `visual_remember` 原样存一次，并把图上关键文字/结论写进 `text`——之后才能用文字检索到。',
    '2. **粗到细，留下注意力。** 用 `visual_attend` 把要看的位置画框（写进该条目注意力账本，人能看见 agent 看了哪里），再用 `visual_inspect` 按区域放大读细节；看图用 `read_image`（本机路由支持原生读图）。',
    '3. **跨时间用 `visual_inspect`。** 一次取多张存档观测、各自指定区域放大，拼成带标签的图，用于对比早期帧／回放中间帧。',
    '4. **要精确数值用 `visual_read_pixels`。** 颜色、格子、单像素必须实测：这类问题交给视觉模型会被四舍五入。',
    '5. **多图并排用 `visual_compare`；旧图先检索。** `visual_recall` 支持 query / id / sha256 前缀 / tags / dHash 近似 / turn 区间；不要要求用户重新上传已见过的图。',
    '6. **纯文本路由下不要假装看见了。** 先看 `visual_memory_status` 的 `routeCapability.nativeImageInput`：为 false 时依赖已索引的 `text`；图片块会被替换成 `[image omitted … sha256:xxxxxxxx]`，用 `visual_recall(sha256="…")` 找回原图。',
  ].join('\n')
  ctx.effect(
    () => ctx.systemPrompt.section({ name: 'visual-memory', order: 66, text: section }),
    'visual-memory: prompt section',
  )

  // -------- visual_remember ------------------------------------------------
  ctx.effect(() => ctx.tools.register({
    name: 'visual_remember',
    description:
      'Store an image in lossless visual memory and return a stable id. The exact submitted bytes are committed verbatim to the host attachment store (content-addressed, never re-encoded) and indexed with dimensions, format, sha256 and a perceptual hash, so the same image is deduplicated by content and can be retrieved in a later turn. Optionally index text (OCR/caption you already obtained from vision_glance) and tags to make the entry searchable by visual_recall.',
    parameters: compiledParameters({
      path: { type: 'string', required: true, description: 'Image path, workspace-relative or absolute.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Searchable tags.' },
      note: { type: 'string', description: 'Short free-form note.' },
      text: { type: 'string', description: 'Indexed text for retrieval (OCR or caption).' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const { record, hostPath, root, deduplicated } = await entryForPath(ctx, exec, args.path, {
        tags: args.tags,
        note: args.note,
        text: args.text,
      })
      return jsonSafe({
        id: record.id,
        deduplicated,
        sha256: record.sha256,
        bytes: record.bytes,
        width: record.width,
        height: record.height,
        format: record.format,
        dhash: record.dhash,
        losslessOriginalPath: record.originalHostPath,
        sourcePath: hostPath,
        index: path.join(root, INDEX_FILE),
        note: deduplicated
          ? 'content already in memory: the stored original is byte-identical (sha256 match), nothing was re-encoded'
          : 'stored verbatim; the lossless original is at losslessOriginalPath',
        entry: publicEntry(record),
      })
    },
  }), 'visual-memory: visual_remember')

  // -------- visual_recall --------------------------------------------------
  ctx.effect(() => ctx.tools.register({
    name: 'visual_recall',
    description:
      'Retrieve images from lossless visual memory by free-text query, id, sha256, perceptual-hash similarity or tag. Returns each entry with its lossless original path, indexed text, and its explicit-attention ledger. Use this instead of re-uploading an image that was seen earlier in the session or in a previous turn.',
    parameters: compiledParameters({
      query: { type: 'string', description: 'Free text matched against id, note, indexed text, tags and paths.' },
      id: { type: 'string', description: 'Exact memory id (VM-…).' },
      sha256: { type: 'string', description: 'Exact content hash.' },
      near: { type: 'string', description: 'An id or dHash hex: also return visually near-identical entries (dHash Hamming distance).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Require every listed tag.' },
      turnFrom: { type: 'integer', description: 'Only observations recorded at or after this session turn.' },
      turnTo: { type: 'integer', description: 'Only observations recorded at or before this session turn.' },
      order: { type: 'string', description: 'recorded (default, newest first) | chronological (oldest first, for replay).' },
      limit: { type: 'integer', description: 'Maximum entries to return (default 10).' },
      verify: { type: 'boolean', description: 'Re-hash every returned original on disk and report integrity.' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const root = storeRoot(exec)
      await rememberRoot(root)
      const records = await loadRecords(root)
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 10
      let hits = records

      if (typeof args.id === 'string' && args.id !== '') {
        hits = hits.filter((record) => record.id === args.id)
      }
      if (typeof args.sha256 === 'string' && args.sha256 !== '') {
        hits = hits.filter((record) => record.sha256.startsWith(args.sha256))
      }
      if (Array.isArray(args.tags) && args.tags.length > 0) {
        hits = hits.filter((record) => args.tags.every((tag) => (record.tags || []).includes(tag)))
      }
      if (Number.isInteger(args.turnFrom)) {
        hits = hits.filter((record) => typeof record.turn === 'number' && record.turn >= args.turnFrom)
      }
      if (Number.isInteger(args.turnTo)) {
        hits = hits.filter((record) => typeof record.turn === 'number' && record.turn <= args.turnTo)
      }
      if (typeof args.query === 'string' && args.query.trim() !== '') {
        hits = hits
          .map((record) => ({ record, score: scoreRecord(record, args.query.trim()) }))
          .filter((entry) => entry.score > 0)
          .sort((left, right) => right.score - left.score)
          .map((entry) => entry.record)
      } else if (args.order === 'chronological') {
        // Oldest first: the order a replay needs.
        hits = hits.slice().sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
      } else {
        hits = hits.slice().sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      }

      let near = []
      if (typeof args.near === 'string' && args.near !== '') {
        const reference = args.near.startsWith('VM-')
          ? records.find((record) => record.id === args.near)
          : undefined
        const dhash = reference !== undefined ? reference.dhash : args.near
        near = records
          .filter((record) => record.dhash !== dhash)
          .map((record) => ({ id: record.id, distance: hammingHex(record.dhash, dhash), dhash: record.dhash }))
          .filter((entry) => entry.distance <= 8)
          .sort((left, right) => left.distance - right.distance)
        // A near-duplicate question is a retrieval, not a decorator: when it is
        // the only selector, the result list becomes the reference followed by
        // its neighbours, ordered by distance.
        const onlyNearSelector = !(typeof args.query === 'string' && args.query.trim() !== '')
          && !(typeof args.id === 'string' && args.id !== '')
          && !(typeof args.sha256 === 'string' && args.sha256 !== '')
          && !(Array.isArray(args.tags) && args.tags.length > 0)
          && !Number.isInteger(args.turnFrom) && !Number.isInteger(args.turnTo)
        if (onlyNearSelector) {
          const ordered = []
          if (reference !== undefined) ordered.push({ record: reference, distance: 0 })
          for (const entry of near) {
            const record = records.find((candidate) => candidate.id === entry.id)
            if (record !== undefined) ordered.push({ record, distance: entry.distance })
          }
          hits = ordered.map((entry) => entry.record)
          near = near.map((entry) => {
            const found = ordered.find((candidate) => candidate.record.id === entry.id)
            return found === undefined ? entry : { ...entry, seq: found.record.seq }
          })
        }
      }

      const selected = hits.slice(0, limit)
      const integrity = []
      if (args.verify === true) {
        for (const record of selected) {
          try {
            const bytes = new Uint8Array(await fs.readFile(record.originalHostPath))
            const actual = sha256Hex(bytes)
            integrity.push({ id: record.id, ok: actual === record.sha256, actual: actual.slice(0, 16) })
          } catch (error) {
            integrity.push({ id: record.id, ok: false, error: String(error?.message ?? error) })
          }
        }
      }
      const capability = await routeCapability(ctx, exec)
      return jsonSafe({
        storeRoot: root,
        total: records.length,
        returned: selected.length,
        entries: selected.map(publicEntry),
        nearMatches: near,
        integrity: integrity.length > 0 ? integrity : undefined,
        routeCapability: capability,
        howToView:
          capability.nativeImageInput === true
            ? 'read_image(losslessOriginalPath) to see the exact stored bytes'
            : 'this route declares no image input: use vision_glance with the path, and rely on the indexed text when the image cannot be attached',
      })
    },
  }), 'visual-memory: visual_recall')

  // -------- visual_attend --------------------------------------------------
  ctx.effect(() => ctx.tools.register({
    name: 'visual_attend',
    description:
      'Record and visualise explicit attention: draw labelled boxes for regions you decided to look at onto a copy of the image, append them to that entry\'s attention ledger, and return the annotated artifact. Use it with vision_ground (which finds a box) and vision_crop/vision_glance (which read it): ground -> attend (make the attention visible and durable) -> crop/glance. An image given by path is remembered first, so attention always lands on a lossless entry.',
    parameters: compiledParameters({
      id: { type: 'string', description: 'Memory id (VM-…) to attach attention to.' },
      path: { type: 'string', description: 'Image path instead of id; it is remembered first.' },
      regions: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        required: true,
        description: 'Regions to attend: [{x1,y1,x2,y2,label?}] in original-image pixels.',
      },
      scale: { type: 'integer', description: 'Upscale the overlay 1-8 for legibility.' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const regions = Array.isArray(args.regions) ? args.regions : []
      if (regions.length === 0) throw new Error('visual_attend requires at least one region')
      const root = storeRoot(exec)
      await rememberRoot(root)
      let record
      if (typeof args.id === 'string' && args.id !== '') {
        const records = await loadRecords(root)
        record = records.find((entry) => entry.id === args.id)
        if (record === undefined) throw new Error('no visual-memory entry with id ' + args.id)
      } else if (typeof args.path === 'string' && args.path !== '') {
        record = (await entryForPath(ctx, exec, args.path, {})).record
      } else {
        throw new Error('visual_attend requires either id or path')
      }

      const stamp = Date.now().toString(36)
      const output = path.join(root, 'artifacts', 'attention', record.id + '-' + stamp + '.png')
      const result = await runPython({
        op: 'overlay',
        path: record.originalHostPath,
        output,
        scale: Number.isInteger(args.scale) ? args.scale : 1,
        regions: regions.map((region, index) => ({
          x1: region.x1, y1: region.y1, x2: region.x2, y2: region.y2,
          label: region.label ?? 'R' + (index + 1),
        })),
      })

      const ledger = (record.rois || []).slice()
      for (const region of result.regions) {
        ledger.push({ ...region, at: new Date().toISOString() })
      }
      const updated = { ...record, rois: ledger, overlays: [...(record.overlays || []), output] }
      await appendRecord(root, updated)

      return jsonSafe({
        id: updated.id,
        overlayPath: output,
        overlaySize: { width: result.width, height: result.height },
        regions: result.regions,
        ledgerSize: ledger.length,
        losslessOriginalPath: updated.originalHostPath,
        next: 'vision_crop or vision_glance with region="x1,y1,x2,y2" on losslessOriginalPath reads the attended detail; a PNG overlay was written so a human can see exactly what was attended',
      })
    },
  }), 'visual-memory: visual_attend')

  // -------- visual_inspect (VISTA `inspect`: N views over time x space) ----
  ctx.effect(() => ctx.tools.register({
    name: 'visual_inspect',
    description:
      'Answer one visual question by retrieving several views from visual memory in a single call: each view names an archived observation (id or path) and optionally a rectangular region of it, and every view is cut from the ORIGINAL observation and enlarged, then assembled into one labelled sheet. This is the time x space inspection primitive — retrieve frames from earlier turns, compare states, and read a detail that the full image is too small to show. Ad-hoc cropping of an image that is not in memory stays with vision_crop.',
    parameters: compiledParameters({
      views: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        required: true,
        description: 'Views to assemble: [{id|path, region?: "x1,y1,x2,y2", label?, scale?}]. Each view returns one image cell.',
      },
      question: { type: 'string', description: 'The visual question these views should answer (recorded with the sheet).' },
      scale: { type: 'integer', description: 'Default enlargement for views without their own scale (1-8).' },
      layout: { type: 'string', description: 'side-by-side (default) | grid | stack.' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const views = Array.isArray(args.views) ? args.views : []
      if (views.length === 0) throw new Error('visual_inspect requires at least one view')
      const root = storeRoot(exec)
      await rememberRoot(root)
      const records = await loadRecords(root)
      const stamp = Date.now().toString(36)
      const dir = path.join(root, 'artifacts', 'inspect')
      const items = []
      const resolved = []
      for (let index = 0; index < views.length; index += 1) {
        const view = views[index] ?? {}
        let source
        let label
        let provenance = null
        if (typeof view.id === 'string' && view.id !== '') {
          const record = records.find((candidate) => candidate.id === view.id)
          if (record === undefined) throw new Error('no visual-memory entry with id ' + view.id)
          source = record.originalHostPath
          provenance = { id: record.id, turn: record.turn, seq: record.seq }
          label = view.label ?? (record.id + (typeof record.turn === 'number' ? ' · turn ' + record.turn : ''))
        } else if (typeof view.path === 'string' && view.path !== '') {
          const resolvedPath = await resolveHostPath(ctx, exec, view.path)
          source = resolvedPath.hostPath
          label = view.label ?? path.basename(source)
        } else {
          throw new Error('visual_inspect view ' + (index + 1) + ' needs id or path')
        }
        let regionBox = null
        if (typeof view.region === 'string' && view.region.trim() !== '') {
          const parts = view.region.split(',').map((value) => Number(value.trim()))
          if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
            throw new Error('view ' + (index + 1) + ' region must be "x1,y1,x2,y2"')
          }
          regionBox = { x1: parts[0], y1: parts[1], x2: parts[2], y2: parts[3] }
        } else if (view.region !== null && view.region !== undefined && typeof view.region === 'object') {
          regionBox = view.region
        }
        const scale = Number.isInteger(view.scale) ? view.scale : (Number.isInteger(args.scale) ? args.scale : 1)
        const output = path.join(dir, 'view-' + stamp + '-' + (index + 1) + '.png')
        const cropped = await runPython({
          op: 'crop',
          path: source,
          output,
          region: regionBox,
          scale: scale > 1 ? scale : 1,
        })
        items.push({ path: cropped.output, label })
        resolved.push({
          view: index + 1,
          label,
          source,
          sourceId: provenance?.id ?? null,
          turn: provenance?.turn ?? null,
          region: cropped.region,
          scale: cropped.scale,
          output: cropped.output,
          width: cropped.width,
          height: cropped.height,
        })
      }
      const sheet = path.join(dir, 'inspect-' + stamp + '.png')
      const composed = await runPython({
        op: 'compose',
        output: sheet,
        items,
        mode: typeof args.layout === 'string' ? args.layout : 'side-by-side',
        labels: items.map((item) => item.label),
        title: typeof args.question === 'string' ? args.question : undefined,
        gap: 18,
        maxCell: 900,
      })
      return jsonSafe({
        sheetPath: sheet,
        width: composed.width,
        height: composed.height,
        layout: composed.mode,
        question: typeof args.question === 'string' ? args.question : null,
        views: resolved,
        next: 'read_image(sheetPath) to look at the assembled views; the per-view crops are also on disk if one detail needs its own look',
      })
    },
  }), 'visual-memory: visual_inspect')

  // -------- visual_read_pixels (VISTA `read_pixels`) -----------------------
  ctx.effect(() => ctx.tools.register({
    name: 'visual_read_pixels',
    description:
      'Read exact pixel values from a region of an archived observation: split the region into rows x cols cells and return the centre colour of each cell as #rrggbb, plus the distinct values in order. This is a measurement, not a description — use it when a colour, a grid cell or a one-pixel detail has to be exact (a vision model will round it off). Palette description stays with vision_dominant_colors; this tool returns the cell matrix.',
    parameters: compiledParameters({
      id: { type: 'string', description: 'Memory id (VM-…) to read from.' },
      path: { type: 'string', description: 'Image path instead of id.' },
      region: { type: 'string', description: 'Pixel box "x1,y1,x2,y2" (default: the whole image).' },
      rows: { type: 'integer', description: 'Cell rows (default 8).' },
      cols: { type: 'integer', description: 'Cell columns (default 8).' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const root = storeRoot(exec)
      await rememberRoot(root)
      let source
      let entryId = null
      if (typeof args.id === 'string' && args.id !== '') {
        const records = await loadRecords(root)
        const record = records.find((candidate) => candidate.id === args.id)
        if (record === undefined) throw new Error('no visual-memory entry with id ' + args.id)
        source = record.originalHostPath
        entryId = record.id
      } else if (typeof args.path === 'string' && args.path !== '') {
        source = (await resolveHostPath(ctx, exec, args.path)).hostPath
      } else {
        throw new Error('visual_read_pixels requires either id or path')
      }
      let regionBox = null
      if (typeof args.region === 'string' && args.region.trim() !== '') {
        const parts = args.region.split(',').map((value) => Number(value.trim()))
        if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
          throw new Error('region must be "x1,y1,x2,y2"')
        }
        regionBox = { x1: parts[0], y1: parts[1], x2: parts[2], y2: parts[3] }
      }
      const result = await runPython({
        op: 'pixels',
        path: source,
        region: regionBox,
        rows: Number.isInteger(args.rows) ? args.rows : 8,
        cols: Number.isInteger(args.cols) ? args.cols : 8,
      })
      return jsonSafe({ entryId, source, ...result })
    },
  }), 'visual-memory: visual_read_pixels')

  // -------- visual_compare -------------------------------------------------
  ctx.effect(() => ctx.tools.register({
    name: 'visual_compare',
    description:
      'Compose a labelled side-by-side / grid / stack sheet from two or more images (memory ids or paths) into one PNG, so several images are read in a single glance by a model or a human. For the numeric question "where do these two differ", vision_pixel_diff owns that — this tool produces the visual sheet, not the diff arithmetic.',
    parameters: compiledParameters({
      entries: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Two or more memory ids (VM-…) or image paths, left-to-right / top-to-bottom.',
      },
      mode: { type: 'string', description: 'side-by-side (default) | grid | stack.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Caption per entry.' },
      title: { type: 'string', description: 'Sheet title.' },
      gap: { type: 'integer', description: 'Gap in pixels (default 18).' },
      maxCell: { type: 'integer', description: 'Largest cell edge in pixels (default 900).' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const entries = Array.isArray(args.entries) ? args.entries : []
      if (entries.length < 2) throw new Error('visual_compare requires at least two entries')
      const root = storeRoot(exec)
      await rememberRoot(root)
      const records = await loadRecords(root)
      const items = []
      const resolved = []
      for (const entry of entries) {
        if (typeof entry === 'string' && entry.startsWith('VM-')) {
          const record = records.find((candidate) => candidate.id === entry)
          if (record === undefined) throw new Error('no visual-memory entry with id ' + entry)
          items.push({ path: record.originalHostPath, label: record.id })
          resolved.push(record.id)
        } else {
          const { hostPath } = await resolveHostPath(ctx, exec, entry)
          items.push({ path: hostPath, label: path.basename(hostPath) })
          resolved.push(hostPath)
        }
      }
      const stamp = Date.now().toString(36)
      const output = path.join(root, 'artifacts', 'compare', 'compare-' + stamp + '.png')
      const result = await runPython({
        op: 'compose',
        output,
        items,
        mode: typeof args.mode === 'string' ? args.mode : 'side-by-side',
        labels: Array.isArray(args.labels) ? args.labels.map(String) : items.map((item) => item.label),
        title: typeof args.title === 'string' ? args.title : undefined,
        gap: Number.isInteger(args.gap) ? args.gap : 18,
        maxCell: Number.isInteger(args.maxCell) ? args.maxCell : 900,
      })

      for (const entry of entries) {
        if (typeof entry === 'string' && entry.startsWith('VM-')) {
          const record = records.find((candidate) => candidate.id === entry)
          if (record !== undefined) {
            await appendRecord(root, { ...record, composites: [...(record.composites || []), output] })
          }
        }
      }

      return jsonSafe({
        compositePath: output,
        width: result.width,
        height: result.height,
        mode: result.mode,
        layout: { columns: result.columns, rows: result.rows },
        panels: result.panels,
        inputs: resolved,
        numericDiffOwner: 'vision_pixel_diff',
        renderToImage: 'the sheet is already a PNG; read_image(compositePath) to look at it, or vision_glance(images=[...]) to have the vision model compare the same set',
      })
    },
  }), 'visual-memory: visual_compare')

  // -------- visual_memory_status ------------------------------------------
  ctx.effect(() => ctx.tools.register({
    name: 'visual_memory_status',
    description:
      'Report the visual-memory capability of this session as facts: store root, entry count and bytes, whether the lossless attachment store is host-file backed, the exact routed model and whether it declares image input (the hybrid-model answer), and which dsh-vision-toolkit capabilities are actually registered right now.',
    parameters: compiledParameters({}),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value),
    },
    async execute(_args, exec) {
      const root = storeRoot(exec)
      await rememberRoot(root)
      const records = await loadRecords(root)
      const capability = await routeCapability(ctx, exec)
      const vision = visionToolState(ctx, exec)
      // Do not claim losslessness from an empty store: check the real stored
      // originals, and report "unverified" honestly when there are none yet.
      let present = 0
      for (const record of records) {
        if (typeof record.originalHostPath !== 'string') continue
        try {
          await fs.access(record.originalHostPath)
          present += 1
        } catch {
          // counted as missing below
        }
      }
      return jsonSafe({
        storeRoot: root,
        index: path.join(root, INDEX_FILE),
        entries: records.length,
        originalBytes: records.reduce((sum, record) => sum + (record.bytes || 0), 0),
        attentionRegions: records.reduce((sum, record) => sum + (record.rois || []).length, 0),
        overlays: records.reduce((sum, record) => sum + (record.overlays || []).length, 0),
        composites: records.reduce((sum, record) => sum + (record.composites || []).length, 0),
        lossless: {
          backend: 'ctx.attachments.saveFile (verbatim, content-addressed)',
          hostFileBacked: records.length === 0 ? null : present === records.length,
          checkedAgainst: records.length,
          originalsOnDisk: present,
          reEncodedOnWrite: false,
          note: records.length === 0
            ? 'no entries yet: losslessness is unverified until the first visual_remember'
            : (present === records.length ? 'every indexed original is present on disk' : 'some indexed originals are missing from disk'),
        },
        routeCapability: capability,
        visionToolkit: vision,
        gallery: '/_dsh/visual-memory/gallery',
      })
    },
  }), 'visual-memory: visual_memory_status')

  // -------- web seam: gallery + raw ---------------------------------------
  //
  // This route is reachable from any browser that can address the Host port, so
  // it is not the Agent's authority boundary and must not be treated as one:
  //   1. every request asks the composition's `connection` service for a
  //      rejection first — its Host/Origin fence defeats DNS rebinding and
  //      cross-site calls, and its browser authentication gates the rest;
  //   2. `root` must be a root this plugin itself registered, never a caller
  //      supplied path;
  //   3. `v` may name only a variant the record already lists (`overlays` /
  //      `composites`), and its resolved path must stay inside this store's
  //      `artifacts/` directory. Nothing caller-controlled reaches fs.readFile.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/_dsh/visual-memory',
    async handler(req, res) {
      const send = (status, body, type) => {
        res.writeHead(status, {
          'content-type': type,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        res.end(body)
      }
      // Fail closed: a composition without the trust service must not serve bytes.
      const connection = ctx.connection
      if (connection === undefined || typeof connection.requestRejection !== 'function') {
        return send(503, 'visual-memory: connection trust service unavailable', 'text/plain; charset=utf-8')
      }
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      const url = new URL(req?.url ?? '/', 'http://127.0.0.1')
      const roots = await knownRoots()
      const requested = url.searchParams.get('root')
      let root = roots[0]?.root ?? path.join(process.cwd(), STORE_DIRNAME)
      if (typeof requested === 'string' && requested !== '') {
        const known = roots.find((entry) => entry.root === requested)
        if (known === undefined) return send(400, 'unknown store root', 'text/plain; charset=utf-8')
        root = known.root
      }
      try {
        if (url.pathname === '/_dsh/visual-memory/raw') {
          const id = url.searchParams.get('id')
          const records = await loadRecords(root)
          const record = records.find((candidate) => candidate.id === id)
          if (record === undefined) return send(404, 'no such entry', 'text/plain; charset=utf-8')
          const target = await rawTargetFor(record, url.searchParams.get('v'), root)
          if (target === undefined) return send(404, 'no such variant', 'text/plain; charset=utf-8')
          const bytes = await fs.readFile(target)
          const type = target === record.originalHostPath
            ? 'image/' + (record.format === 'jpg' ? 'jpeg' : record.format || 'png')
            : 'image/png'
          return send(200, bytes, type)
        }
        const records = await loadRecords(root)
        const capability = await routeCapability(ctx, {})
        const vision = visionToolState(ctx, {})
        return send(200, galleryHtml(records, capability, vision, root, roots), 'text/html; charset=utf-8')
      } catch (error) {
        return send(500, 'visual-memory gallery error: ' + String(error?.message ?? error), 'text/plain; charset=utf-8')
      }
    },
  }), 'visual-memory: gallery route')
}
