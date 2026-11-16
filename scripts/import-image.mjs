/**
 * 划斜线（Gokigen Naname）—— 从题图自动导入题库
 *
 * 用法：
 *   node scripts/import-image.mjs <图片路径> [--name 名称] [--id ID] [--series 系列]
 *                                 [--append] [--verify] [--dry]
 *                                 [--map 簇号=数字,...] [--width W --height H]
 *                                 [--budget 节点数]
 *
 * 流程：
 *   1. Playwright + Edge 打开图片到 canvas，取像素；
 *   2. 浅灰网格线投影求棋盘范围与格距（无网格线时可用 --width/--height 指定）；
 *   3. 在每个顶点附近裁切、连通域切字，与内置粗体数字模板比对识别 0..4，
 *      无字形 = 无数字；识别簇可用 --map 人工覆盖；
 *   4. 生成 clues（(W+1)*(H+1) 个顶点）；--verify 用 esbuild 打包 src/solver.ts
 *      校验有解/唯一解（超时只警告）；
 *   5. 预览；--append 追加到 src/puzzles-data.ts（含参考解）。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { build } from 'esbuild'

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

function findEdge() {
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p
  throw new Error('找不到 Microsoft Edge，可用环境变量 EDGE_PATH 指定 msedge.exe 路径')
}

function usage(msg) {
  console.error(`[划斜线识图] ${msg}`)
  console.error(
    '用法：node scripts/import-image.mjs <图片路径> [--name 名称] [--id ID] [--series 系列] [--append] [--verify] [--dry] [--map 簇号=数字] [--width W --height H] [--budget 节点数]',
  )
  process.exit(1)
}

function parseArgs(argv) {
  const out = { file: null, name: null, id: null, series: '识图', append: false, verify: false, dry: false, maps: {}, width: 0, height: 0, budget: 0 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) usage(`参数 ${a} 缺少值`)
      return v
    }
    if (a === '--name') out.name = next()
    else if (a === '--id') out.id = next()
    else if (a === '--series') out.series = next()
    else if (a === '--append') out.append = true
    else if (a === '--verify') out.verify = true
    else if (a === '--dry') out.dry = true
    else if (a === '--width') out.width = Number(next()) || 0
    else if (a === '--height') out.height = Number(next()) || 0
    else if (a === '--budget') out.budget = Math.max(1000, Number(next()) || 0)
    else if (a === '--map') {
      for (const token of next().split(',')) {
        const m = /^(\d+)=(\d)$/.exec(token.trim())
        if (!m) usage(`--map 格式应为 簇号=数字，收到「${token}」`)
        out.maps[Number(m[1])] = Number(m[2])
      }
    } else if (!a.startsWith('--')) {
      if (out.file) usage(`多余参数 ${a}`)
      out.file = a
    } else usage(`未知参数 ${a}`)
  }
  if (!out.file) usage('请指定图片路径')
  return out
}

const DIGIT_FONTS = ['Verdana', 'Tahoma', 'Arial', 'Segoe UI', 'DejaVu Sans', 'Arial Black']
const DIGIT_WEIGHTS = ['600', '700', '800', '900']

const args = parseArgs(process.argv.slice(2))
const imagePath = path.resolve(args.file)
if (!existsSync(imagePath)) usage(`找不到图片：${imagePath}`)

const dataUrl = `data:image/png;base64,${readFileSync(imagePath).toString('base64')}`
const browser = await chromium.launch({ headless: true, executablePath: findEdge() })
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas>')

const detected = await page.evaluate(async ({ dataUrl, widthOpt, heightOpt }) => {
  const N = 24
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const W = img.naturalWidth
  const H = img.naturalHeight
  const cv = document.getElementById('c')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d', { willReadFrequently: true })
  g.drawImage(img, 0, 0)
  const d = g.getImageData(0, 0, W, H).data
  const rgb = (x, y) => {
    const i = (y * W + x) * 4
    return [d[i], d[i + 1], d[i + 2]]
  }
  const dark = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return false
    const c = rgb(x, y)
    return c[0] < 110 && c[1] < 110 && c[2] < 110
  }
  const isGrid = (c) => {
    const mx = Math.max(c[0], c[1], c[2])
    const mn = Math.min(c[0], c[1], c[2])
    const lum = (c[0] + c[1] + c[2]) / 3
    return mx - mn <= 12 && lum >= 140 && lum <= 238
  }
  const colCount = new Int32Array(W)
  const rowCount = new Int32Array(H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isGrid(rgb(x, y))) { colCount[x]++; rowCount[y]++ }
  const peaks = (counts, min) => {
    const out = []
    let st = -1
    for (let i = 0; i <= counts.length; i++) {
      const on = i < counts.length && counts[i] >= min
      if (on && st < 0) st = i
      if (!on && st >= 0) { out.push((st + i - 1) / 2); st = -1 }
    }
    return out
  }
  let xs = peaks(colCount, H * 0.45)
  let ys = peaks(rowCount, W * 0.45)
  // 过滤图片边缘 1px 杂线
  xs = xs.filter((v) => v > 2 && v < W - 2)
  ys = ys.filter((v) => v > 2 && v < H - 2)
  let w = widthOpt || 0
  let hh = heightOpt || 0
  if (!w) w = xs.length - 1
  if (!hh) hh = ys.length - 1
  if (w < 2 || hh < 2) {
    throw new Error(`网格识别失败（竖线 ${xs.length} 条、横线 ${ys.length} 条）。可用 --width/--height 手动指定棋盘格数`)
  }
  if (xs.length !== w + 1 || ys.length !== hh + 1) {
    // 用首位线 + 等距重采样，兼容线条被数字截断导致漏检的情况
    if (xs.length >= 2 && ys.length >= 2) {
      const x0 = xs[0]
      const cellW = (xs[xs.length - 1] - x0) / (xs.length - 1)
      const y0 = ys[0]
      const cellH = (ys[ys.length - 1] - y0) / (ys.length - 1)
      xs = Array.from({ length: w + 1 }, (_, i) => x0 + i * cellW)
      ys = Array.from({ length: hh + 1 }, (_, i) => y0 + i * cellH)
    } else {
      throw new Error(`网格线与目标尺寸不匹配：识别 ${xs.length}×${ys.length} 条线，目标是 ${w + 1}×${hh + 1} 条`)
    }
  }
  const x0 = xs[0]
  const y0 = ys[0]
  const cellW = (xs[w] - x0) / w
  const cellH = (ys[hh] - y0) / hh
  // 每个顶点裁切；顶点周围网格线是浅灰，数字是深色
  const cut = (cx, cy) => {
    const hw = Math.round(cellW * 0.3)
    const hh2 = Math.round(cellH * 0.3)
    const bx0 = Math.round(cx - hw)
    const bx1 = Math.round(cx + hw)
    const by0 = Math.round(cy - hh2)
    const by1 = Math.round(cy + hh2)
    const comps = []
    const seen = new Uint8Array(W * H)
    for (let y = Math.max(1, by0); y <= Math.min(H - 2, by1); y++) for (let x = Math.max(1, bx0); x <= Math.min(W - 2, bx1); x++) {
      if (!dark(x, y) || seen[y * W + x]) continue
      const stack = [[x, y]]
      seen[y * W + x] = 1
      let minX = x, maxX = x, minY = y, maxY = y, n = 0
      while (stack.length) {
        const [px, py] = stack.pop()
        n++
        if (px < minX) minX = px
        if (px > maxX) maxX = px
        if (py < minY) minY = py
        if (py > maxY) maxY = py
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx
          const ny = py + dy
          if (nx < bx0 || nx > bx1 || ny < by0 || ny > by1) continue
          if (seen[ny * W + nx] || !dark(nx, ny)) continue
          seen[ny * W + nx] = 1
          stack.push([nx, ny])
        }
      }
      if (n >= 8) comps.push({ minX, maxX, minY, maxY, n })
    }
    comps.sort((a, b) => a.minX - b.minX)
    const glyphs = []
    for (const c of comps) {
      const gw = c.maxX - c.minX + 1
      const gh = c.maxY - c.minY + 1
      if (c.minX <= bx0 + 1 || c.maxX >= bx1 - 1 || c.minY <= by0 + 1 || c.maxY >= by1 - 1) continue
      if (gh < 7 || gh > (by1 - by0) * 0.85) continue
      if (gw > gh * 1.5) continue
      // 归一化到 24×24
      const m = new Array(N * N).fill(0)
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const sx = c.minX + Math.floor((gw * i) / N)
        const sy = c.minY + Math.floor((gh * j) / N)
        m[j * N + i] = dark(sx, sy) ? 1 : 0
      }
      glyphs.push({ m, minX: c.minX })
    }
    return glyphs
  }
  const cells = []
  for (let py = 0; py <= hh; py++) {
    const row = []
    for (let px = 0; px <= w; px++) row.push(cut(x0 + px * cellW, y0 + py * cellH))
    cells.push(row)
  }
  return { W, H, w, h: hh, x0, y0, cellW, cellH, cells }
}, { dataUrl, widthOpt: args.width, heightOpt: args.height })

/* ───────── 数字模板 ───────── */
const templates = await page.evaluate(({ fonts, weights }) => {
  const N = 24
  const res = []
  const cv = document.createElement('canvas')
  cv.width = 100
  cv.height = 100
  const g = cv.getContext('2d', { willReadFrequently: true })
  const norm = (raw, G) => {
    let ax0 = G, ay0 = G, ax1 = -1, ay1 = -1
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) if (raw[j * G + i]) { if (i < ax0) ax0 = i; if (i > ax1) ax1 = i; if (j < ay0) ay0 = j; if (j > ay1) ay1 = j }
    if (ax1 < 0) return null
    const bw = ax1 - ax0 + 1, bh = ay1 - ay0 + 1
    const o = new Array(N * N).fill(0)
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) o[j * N + i] = raw[(ay0 + Math.floor((bh * j) / N)) * G + (ax0 + Math.floor((bw * i) / N))] ? 1 : 0
    return o
  }
  for (const font of fonts) for (const weight of weights) for (let digit = 0; digit <= 4; digit++) {
    g.fillStyle = '#fff'
    g.fillRect(0, 0, 100, 100)
    g.fillStyle = '#000'
    g.font = `${weight} 76px "${font}"`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(String(digit), 50, 50)
    const dd = g.getImageData(0, 0, 100, 100).data
    const G = 36
    const raw = new Array(G * G).fill(0)
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      const x = Math.floor((i * 100) / G)
      const y = Math.floor((j * 100) / G)
      raw[j * G + i] = dd[(y * 100 + x) * 4] < 100 ? 1 : 0
    }
    const m = norm(raw, G)
    if (m) res.push({ font, weight, digit, m })
  }
  return res
}, { fonts: DIGIT_FONTS, weights: DIGIT_WEIGHTS })
await browser.close()

const sim = (a, b) => {
  let inter = 0
  let union = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter++
    if (a[i] || b[i]) union++
  }
  return union ? inter / union : 0
}

const { w, h, cells } = detected
console.log(
  `[划斜线识图] ${path.basename(imagePath)}：棋盘 ${w}×${h}，格子 ${detected.cellW.toFixed(1)}×${detected.cellH.toFixed(1)}px`,
)
const clueClusters = []
const clues = new Array((w + 1) * (h + 1)).fill(null)
let clueCount = 0
for (let py = 0; py <= h; py++) {
  for (let px = 0; px <= w; px++) {
    const glyphs = cells[py][px]
    if (!glyphs.length) continue
    if (glyphs.length > 1) {
      console.warn(`[划斜线识图] 警告：顶点 (${px},${py}) 出现 ${glyphs.length} 个字形，只看第一个`)
    }
    const gl = glyphs[0].m
    const scores = templates.map((t) => [t, sim(gl, t.m)]).sort((a, b) => b[1] - a[1])
    let cluster = -1
    for (let k = 0; k < clueClusters.length; k++) if (sim(gl, clueClusters[k].proto) >= 0.9) { cluster = k; break }
    if (cluster < 0) { clueClusters.push({ proto: gl, digit: scores[0][0].digit, count: 1 }); cluster = clueClusters.length - 1 }
    else clueClusters[cluster].count++
    const manual = args.maps[cluster]
    const digit = manual ?? scores[0][0].digit
    clues[py * (w + 1) + px] = digit
    clueCount++
  }
}
for (const [k, c] of clueClusters.entries()) {
  const auto = templates.map((t) => [t.digit, sim(c.proto, t.m)]).sort((a, b) => b[1] - a[1])
  const digit = args.maps[k] ?? c.digit
  console.log(`[划斜线识图] 数字簇${k} → ${digit}（${args.maps[k] !== undefined ? '人工' : '自动'}，n=${c.count}，IoU ${auto[0][1].toFixed(2)}）`)
}
const cluesText = clues.map((v) => (v === null ? '.' : String(v))).join('')
console.log(`[划斜线识图] 数字 ${clueCount} 个：${cluesText}`)
console.log(`[划斜线识图] 顶点数字网格（${w + 1}×${h + 1}，. 为无数字）：`)
for (let py = 0; py <= h; py++) {
  console.log('  ' + cluesText.slice(py * (w + 1), py * (w + 1) + w + 1).replace(/(.)/g, '$1 '))
}

if (!clueCount) usage('没有识别到任何顶点数字，可能不是划斜线题图')
if (args.dry) {
  console.log('[划斜线识图] --dry：仅识别，不求解、不写入。')
  process.exit(0)
}

/* ───────── 用 esbuild 打包 solver 校验 ───────── */
const bundled = await build({
  entryPoints: [path.resolve('src/solver.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
})
const solver = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const puzzle = {
  id: 'preview',
  name: 'preview',
  width: w,
  height: h,
  difficulty: 'hard',
  clues,
  solution: undefined,
}
const budget = args.budget || (w * h > 200 ? 6_000_000 : 2_000_000)
let solutionText = ''
const t0 = Date.now()
const solved = solver.solvePuzzle(puzzle, { maxNodes: budget })
if (!solved.solved) {
  if (solved.timedOut) console.warn(`[划斜线识图] 警告：求解超时（${Date.now() - t0}ms），未能给出参考解`)
  else console.warn('[划斜线识图] 警告：识别出的数字无解（可能有数字识别错误），仍可导入，参考解留空')
} else {
  solutionText = solved.solution.cells.map((c) => (c === 1 ? '\\' : '/')).join('')
  console.log(`[划斜线识图] 找到解（${Date.now() - t0}ms）`)
  if (args.verify) {
    const counted = solver.countSolutions(puzzle, 2, { maxNodes: budget })
    if (counted.timedOut) console.warn('[划斜线识图] 警告：唯一性检查超时，未能确认解唯一')
    else if (counted.count > 1) console.warn(`[划斜线识图] 警告：解不唯一（至少 ${counted.count} 个）`)
    else console.log('[划斜线识图] 唯一解 ✓')
  }
}

if (!args.append) {
  console.log('[划斜线识图] 预览模式，未写入题库。加 --append 写入 src/puzzles-data.ts。')
  process.exit(0)
}

/* ───────── 写入题库 ───────── */
const id = args.id || `gokigen-import-${Date.now().toString(36)}`
const name = args.name || `识图 · ${w}×${h}`
const sol = solutionText ? `, solution: ${JSON.stringify(solutionText)}` : ''
const entry = `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, width: ${w}, height: ${h}, difficulty: "hard", series: ${JSON.stringify(args.series)}, clues: ${JSON.stringify(cluesText)}${sol} },\n`
const dataFile = path.resolve('src/puzzles-data.ts')
if (!existsSync(dataFile)) usage(`找不到题库文件：${dataFile}`)
if (process.env.IMPORT_DEBUG) writeFileSync(path.resolve('scripts/.import-debug.json'), JSON.stringify({ w, h, clues, cluesText }))
let text = readFileSync(dataFile, 'utf8').replace(/\r\n/g, '\n')
const marker = text.lastIndexOf('\n]')
if (marker < 0) usage('puzzles-data.ts 格式异常：找不到结尾 ]')
text = text.slice(0, marker + 1) + '\n' + entry + text.slice(marker + 1)
writeFileSync(dataFile, text)
console.log(`[划斜线识图] 已写入 ${dataFile}`)
console.log(`[划斜线识图] id=${id}  name=${name}`)
console.log('[划斜线识图] 注意：npm run gen 会重新生成该文件并覆盖导入内容。')
