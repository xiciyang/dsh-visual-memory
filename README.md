# dsh-visual-memory

Lossless visual memory for a DSH agent: store an image once, address it forever,
look at it closely, compare it with others, and find it again — with a measured
answer to whether the routed model can actually see.

**Why another memory plugin?** Text memory stores *descriptions*. This stores
*bytes*: the original file is committed verbatim, addressed by sha256, and every
later question is answered from that original — not from a vision model's
paraphrase of it. Two consequences: pixel values stay exact, and the answer does
not change when you switch models.

## Install

```sh
# from the public repository (npm publication pending)
dsh plugin --profile <name> add github:xiciyang/dsh-visual-memory
dsh --profile <name> --dump-config   # expect a "# == dsh-visual-memory" layer
```

From a local checkout:

```sh
git clone https://github.com/xiciyang/dsh-visual-memory
dsh plugin --profile <name> add ./dsh-visual-memory
```

Once published to npm, `dsh plugin --profile <name> add dsh-visual-memory` will be the short form.

## Quick start

```js
// 1. store the screenshot you are looking at, and make it findable
visual_remember({ path: "./shot.png", text: "checkout page, CNY 199, two buttons", tags: ["ui","checkout"] })

// 2. later, find it without re-uploading
visual_recall({ query: "checkout" })            // or sha256 / id / tags / turn range / near-dup

// 3. read the exact colour of a cell (a vision model would round it off)
visual_read_pixels({ id: "VM-…", region: "120,40,200,80", rows: 2, cols: 4 })

// 4. assemble several past frames into one labelled sheet for comparison
visual_inspect({ views: [{ id: "VM-…", region: "0,0,800,600" }, { id: "VM-…" }], layout: "side-by-side" })
```

## Requirements

- DSH **0.2.0-rc.2** (declared as `engines.dsh: ">=0.2.0 <0.3.0"`); the bundle
  manifest is `dsh.bundle.patch`, so `dsh plugin add` activates the layer.
- Node.js **>= 22**.
- Python 3 with **Pillow** (`python3 -m pip install pillow`) — the pixel engine
  (`lib/imaging.py`) is a subprocess; the plugin does not vendor an image codec.
- **Desktop / server only** for now: the pixel engine spawns `python3`, so
  Android is out of scope (`dsh-plugin-lint` flags this as `A2-subprocess-tool`).
  A pure-JS fallback is the obvious next step if mobile matters.
- A model route that declares image input for the *observation* path. The
  plugin probes the live route (`visual_memory_status.routeCapability`) instead
  of assuming; on a text-only route, images are still stored and are reachable
  through the `sha256:xxxxxxxx` handle DSH emits.

## Configuration

There is no config file — three locations follow host conventions, and changing
the session workspace changes the store root:

| What | Where | Notes |
|---|---|---|
| store | `<session workspace>/.dsh-visual-memory/` | one per workspace; `index.jsonl` is append-only |
| registry | `$DSH_HOME/visual-memory-roots.json` | gallery routing; most recent 20 workspaces |
| originals | `$DSH_HOME/attachments/v1/files/<sha>/` | verbatim, content-addressed, not deleted with the index |

To move the store, change the session workspace. To clear memory, delete
`.dsh-visual-memory/` (the originals stay in `attachments/` and can be reclaimed).

## Compatibility

| DSH | Status |
|---|---|
| 0.2.0-rc.2 | verified on 2026-10-17 — `node verify.mjs` 11/11, real tools called end-to-end |
| < 0.2.0 | not tested; `engines.dsh` refuses installation |
| >= 0.3.0 | not tested; widen the range only after running `npm test` on that version |

Built to close the gap against **VISTA: A Visual Harness for Reasoning in an
Interactive World** ([arXiv 2610.02200](https://arxiv.org/abs/2610.02200), Han,
Hu, Qiu, Wu, **Kaiming He**, 2026-10-01), whose harness contributes three
things: *visual observation*, a *lossless visual memory* that "stores every
frame … in its original form" indexed by turn and frame, and *visual
inspection* that works "in space" (an enlarged view of any rectangular region of
the original frame) and "across time" (retrieve and inspect multiple frames from
arbitrary earlier turns).

## Capability map

| VISTA harness component | This plugin |
|---|---|
| Visual observation (model receives the pixels) | DSH native multimodal input — `read_image`; the model route's declared modalities are probed, not assumed |
| Lossless visual memory, original form, indexed by (turn, frame) | `visual_remember` → verbatim bytes in `ctx.attachments.saveFile` (content-addressed, never re-encoded) + an append-only index carrying `turn`/`step`/`seq`/sha256/dHash/dimensions/tags/text |
| Active retrieval of past observations | `visual_recall` — query / id / sha256 prefix / tags / turn range / chronological order / perceptual near-dup |
| Visual inspection *in space* (region of the original, enlarged) | `visual_inspect` views with `region` + `scale`; ad-hoc cropping stays with `vision_crop` |
| Visual inspection *across time* (several frames, one call) | `visual_inspect` assembles N views from N archived observations into one labelled sheet |
| Compare states / replay frames | `visual_compare` (labelled side-by-side / grid / stack); numeric diffs stay with `vision_pixel_diff` |
| Exact pixel values (VISTA `read_pixels`) | `visual_read_pixels` — rows×cols cell matrix of `#rrggbb` centre readings |
| — (hybrid routing, not in the paper) | `visual_memory_status.routeCapability` resolves the live route and reports `nativeImageInput`; text-only routes recover images through the `sha256:xxxxxxxx` handle DSH emits |

## Ownership boundaries

Each capability has exactly one owner, so there is no second implementation to
diverge:

* **bytes** → `ctx.attachments` (host service; verbatim `saveFile`, content-addressed)
* **crop / pixel-diff / palette / trace / OCR / Q&A** → `dsh-vision-toolkit`
  (`vision_crop`, `vision_pixel_diff`, `vision_dominant_colors`, `vision_trace`,
  `vision_glance`)
* **index / attention ledger / labelled composites / multi-view assembly /
  capability probe** → this plugin

`visual_attend` deliberately produces the *annotated overlay + attention ledger*
(what was looked at, made visible and durable) and leaves the crop itself to
`vision_crop`. `visual_inspect` cuts from archived observations because
assembling views out of memory is a distinct capability, not a second crop tool.

## Tools

| Tool | Answers |
|---|---|
| `visual_remember` | store this image losslessly and make it findable |
| `visual_recall` | which image was that / find it by text, hash, tag, turn, or similarity |
| `visual_attend` | draw the regions I examined onto the image and record them |
| `visual_inspect` | give me these N observations, these regions, enlarged, in one sheet |
| `visual_read_pixels` | what exactly is the colour of each cell |
| `visual_compare` | put these images side by side with labels |
| `visual_memory_status` | what is actually available, and can the current model see |

Web seam: `GET /_dsh/visual-memory/gallery` renders the memory (thumbnails,
attention ledger, indexed text, hashes); `/_dsh/visual-memory/raw?id=VM-…`
serves the exact stored original, and `&v=<variant>` serves one overlay or
comparison sheet that the record itself lists.

The web seam is not an Agent authority boundary. Every request is refused
unless the composition's `connection.requestRejection` accepts it (Host/Origin
fence + browser authentication), `root` must be a root this plugin registered,
and `v` is resolved only from the record's own listed variants and only when the
real path stays inside that store's `artifacts/` directory — a caller-supplied
path is never read.

## Storage layout

```
<session workspace>/.dsh-visual-memory/
  index.jsonl                 append-only; folded by id, last write wins
  artifacts/attention/*.png   attention overlays
  artifacts/compare/*.png     comparison sheets
  artifacts/inspect/*.png     per-view crops + assembled sheets
~/.dsh/visual-memory-roots.json   which workspaces have a store (gallery routing)
<DSH_HOME>/attachments/v1/files/<sha>/<name>   the verbatim originals
```

## Verification

```bash
npm test                       # = node verify.mjs
node verify.mjs [path/to/index.jsonl]
```

Runs 17 checks: bundle contract, patch/profile wiring (restart persistence), the
pixel engine against a fixture with authored colours (probe, `read_pixels`,
crop+enlarge, compose, overlay clamping), the web seam's trust fence and path
fence (untrusted request, caller-named root, arbitrary `v` path, symlink escape,
the trusted gallery render, and the two legitimate raw reads), the lossless-JSON invariant (`jsonSafe` on every
tool return — an unguarded `undefined` once rejected a whole call), and
re-hashing every stored original against its recorded sha256.

The host-side path (`ctx.attachments`, `ctx.fs`, `ctx.tools`) is exercised by
calling the real tools; this script does not claim to cover it.

## Provenance

Written after measuring the profile's actual state on 2026-10-04:

* native multimodal input was **live** (a randomised ground-truth image was read
  back exactly, `TEY4KD / 3 circles / BG=(103,74,104)`);
* the external vision service was **dead** because every outbound request went
  through a mihomo proxy returning 502 — the toolkit provider was repointed to a
  directly reachable endpoint, and the toolkit's own health check now reports
  the credential resolvable;
* the vision toolkit's tools are registered into the **agent scope**, so a
  host-scope `ctx.tools.schemas()` cannot see them — the capability probe passes
  the agent (`ctx.tools.schemas(agent)`), the same call the Cordis Inspect Tool
  provider makes.

## License

MIT — see [LICENSE](./LICENSE).
