/**
 * 划斜线（Gokigen Naname）—— 从题图自动导入题库
 *
 * 用法：
 *   node scripts/import-image.mjs <图片路径> [--name 名称] [--id ID] [--series 系列]
 *                                 [--append] [--verify] [--dry] [--json out.json]
 *                                 [--map 簇号=数字,...] [--clue x,y=数字,...]
 *                                 [--width W --height H] [--budget 节点数] [--timeout 秒]
 *
 * 流程：
 *   1. Playwright + Edge 打开图片到 canvas，取像素；
 *   2. 浅灰网格线投影求棋盘范围与格距（无网格线时可用 --width/--height 指定）；
 *   3. 在每个顶点附近裁切、连通域切字；先按「结构特征」（底横、竖干、镂空、上下对称度）
 *      判定 0–4，再用内置多字体模板做交叉校验；同一图上完全相同的字形聚成簇、按簇投票，
 *      避免单个字形抗锯齿差异造成的误判。识别簇可用 --map 人工覆盖，单个顶点可用 --clue 覆盖；
 *   4. 生成 clues（(W+1)*(H+1) 个顶点）；--verify 用 esbuild 打包 src/solver.ts
 *      校验有解/唯一解（大棋盘自动启用深度探测；超时只警告）；
 *   5. 预览；--append 追加到 src/puzzles-data.ts（有解时写参考解）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
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
    '用法：node scripts/import-image.mjs <图片路径> [--name 名称] [--id ID] [--series 系列] [--append] [--verify] [--dry] [--json out.json] [--map 簇号=数字] [--clue x,y=数字] [--width W --height H] [--budget 节点数] [--timeout 秒]',
  )
  process.exit(1)
}

function parseArgs(argv) {
  const out = {
    file: null,
    name: null,
    id: null,
    series: '识图',
    append: false,
    verify: false,
    dry: false,
    json: null,
    maps: {},
    clueOverrides: {},
    width: 0,
    height: 0,
    budget: 0,
    timeout: 0,
  }
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
    else if (a === '--json') out.json = next()
    else if (a === '--width') out.width = Number(next()) || 0
    else if (a === '--height') out.height = Number(next()) || 0
    else if (a === '--budget') out.budget = Math.max(1000, Number(next()) || 0)
    else if (a === '--timeout') out.timeout = Math.max(0, Number(next()) || 0)
    else if (a === '--map') {
      for (const token of next().split(',')) {
        const m = /^(\d+)=(\d)$/.exec(token.trim())
        if (!m) usage(`--map 格式应为 簇号=数字，收到「${token}」`)
        out.maps[Number(m[1])] = Number(m[2])
      }
    } else if (a === '--clue') {
      for (const token of next().split(',')) {
        const m = /^(\d+)\s*,\s*(\d+)\s*=\s*(\d)$/.exec(token.trim())
        if (!m) usage(`--clue 格式应为 x,y=数字，收到「${token}」`)
        out.clueOverrides[`${Number(m[1])},${Number(m[2])}`] = Number(m[3])
      }
    } else if (!a.startsWith('--')) {
      if (out.file) usage(`多余参数 ${a}`)
      out.file = a
    } else usage(`未知参数 ${a}`)
  }
  if (!out.file) usage('请指定图片路径')
  return out
}

const DIGIT_FONTS = [
  'Times New Roman',
  'Georgia',
  'Cambria',
  'Palatino Linotype',
  'DejaVu Serif',
  'Arial',
  'Verdana',
  'Segoe UI',
  'Trebuchet MS',
  'Microsoft YaHei',
  'Consolas',
]
const DIGIT_WEIGHTS = ['400', '700']
const DIGIT_SIZES = [18, 32, 56]
const DIGITS = ['0', '1', '2', '3', '4']

const args = parseArgs(process.argv.slice(2))
const imagePath = path.resolve(args.file)
if (!existsSync(imagePath)) usage(`找不到图片：${imagePath}`)

const dataUrl = `data:image/png;base64,${readFileSync(imagePath).toString('base64')}`
const browser = await chromium.launch({ headless: true, executablePath: findEdge() })
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas>')

const detected = await page.evaluate(
  async ({ dataUrl, widthOpt, heightOpt }) => {
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
    const lum = (x, y) => {
      const i = (y * W + x) * 4
      return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    }
    const isGrid = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false
      const i = (y * W + x) * 4
      const r = d[i]
      const gg = d[i + 1]
      const b = d[i + 2]
      const mx = Math.max(r, gg, b)
      const mn = Math.min(r, gg, b)
      const l = (r + gg + b) / 3
      return mx - mn <= 14 && l >= 120 && l <= 240
    }
    const colCount = new Int32Array(W)
    const rowCount = new Int32Array(H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!isGrid(x, y)) continue
        colCount[x]++
        rowCount[y]++
      }
    }
    const peaks = (counts, min) => {
      const out = []
      let st = -1
      for (let i = 0; i <= counts.length; i++) {
        const on = i < counts.length && counts[i] >= min
        if (on && st < 0) st = i
        if (!on && st >= 0) {
          out.push((st + i - 1) / 2)
          st = -1
        }
      }
      return out
    }
    const dedupe = (vals, tol = 5) => {
      const out = []
      for (const v of vals) {
        if (out.length && v - out[out.length - 1] <= tol) out[out.length - 1] = (out[out.length - 1] + v) / 2
        else out.push(v)
      }
      return out
    }
    let xs = dedupe(peaks(colCount, H * 0.4).filter((v) => v > 3 && v < W - 3))
    let ys = dedupe(peaks(rowCount, W * 0.4).filter((v) => v > 3 && v < H - 3))
    let w = widthOpt || 0
    let hh = heightOpt || 0
    if (!w) w = xs.length - 1
    if (!hh) hh = ys.length - 1
    if (w < 2 || hh < 2) {
      throw new Error(`网格识别失败（竖线 ${xs.length} 条、横线 ${ys.length} 条）。可用 --width/--height 手动指定棋盘格数`)
    }
    if (xs.length !== w + 1 || ys.length !== hh + 1) {
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

    // 每个顶点附近裁切：深色连通域即数字；灰色圆环/浅灰网格线都不算墨
    const cut = (cx, cy, scale) => {
      const hw = Math.round(cellW * 0.26 * scale)
      const hh2 = Math.round(cellH * 0.26 * scale)
      const bx0 = Math.round(cx - hw)
      const bx1 = Math.round(cx + hw)
      const by0 = Math.round(cy - hh2)
      const by1 = Math.round(cy + hh2)
      const darkPx = (x, y) => x >= 0 && y >= 0 && x < W && y < H && lum(x, y) < 110
      const comps = []
      const seen = new Uint8Array(W * H)
      for (let y = Math.max(1, by0); y <= Math.min(H - 2, by1); y++) {
        for (let x = Math.max(1, bx0); x <= Math.min(W - 2, bx1); x++) {
          if (!darkPx(x, y) || seen[y * W + x]) continue
          const stack = [[x, y]]
          seen[y * W + x] = 1
          let minX = x
          let maxX = x
          let minY = y
          let maxY = y
          let n = 0
          while (stack.length) {
            const [px, py] = stack.pop()
            n++
            if (px < minX) minX = px
            if (px > maxX) maxX = px
            if (py < minY) minY = py
            if (py > maxY) maxY = py
            for (const [dx, dy] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ]) {
              const nx = px + dx
              const ny = py + dy
              if (nx < bx0 || nx > bx1 || ny < by0 || ny > by1) continue
              if (seen[ny * W + nx] || !darkPx(nx, ny)) continue
              seen[ny * W + nx] = 1
              stack.push([nx, ny])
            }
          }
          if (n >= 8) comps.push({ minX, maxX, minY, maxY, n })
        }
      }
      comps.sort((a, b) => b.n - a.n)
      const glyphs = []
      for (const c of comps) {
        const gw = c.maxX - c.minX + 1
        const gh = c.maxY - c.minY + 1
        // 数字：高度约为格距 12%~70%，宽高比 0.3~1.1；圆环（大而空）与底纹会被排除
        if (gh < cellH * 0.12 || gh > cellH * 0.7) continue
        if (gw > gh * 1.15 || gw < 2) continue
        if (c.n < 8) continue
        // 允许贴到裁切窗口边（裁切足够大，仍保留）
        const m = new Uint8Array(gw * gh)
        for (let yy = c.minY; yy <= c.maxY; yy++) {
          for (let xx = c.minX; xx <= c.maxX; xx++) {
            if (darkPx(xx, yy)) m[(yy - c.minY) * gw + (xx - c.minX)] = 1
          }
        }
        glyphs.push({ m, w: gw, h: gh, cx: (c.minX + c.maxX) / 2, cy: (c.minY + c.maxY) / 2, ink: c.n })
      }
      return glyphs
    }
    const cells = []
    for (let py = 0; py <= hh; py++) {
      const row = []
      for (let px = 0; px <= w; px++) row.push(cut(x0 + px * cellW, y0 + py * cellH, 1))
      cells.push(row)
    }
    return { W, H, w, h: hh, x0, y0, cellW, cellH, cells }
  },
  { dataUrl, widthOpt: args.width, heightOpt: args.height },
)

/* ───────── 字形特征 / 结构判定 ───────── */

/** 连续 1 的行游程数（用于区分 3 的腰部） */
function runsOfRow(m, w, y) {
  let runs = 0
  let prev = 0
  for (let x = 0; x < w; x++) {
    const v = m[y * w + x]
    if (v && !prev) runs++
    prev = v
  }
  return runs
}

function maxRunOfRow(m, w, y) {
  let best = 0
  let cur = 0
  for (let x = 0; x < w; x++) {
    if (m[y * w + x]) {
      cur++
      if (cur > best) best = cur
    } else cur = 0
  }
  return best
}

/** 镂空个数（4 邻接白色连通域，不接触边界即算洞） */
function holesOf(m, w, h) {
  const seen = new Uint8Array(w * h)
  let holes = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (m[y * w + x] || seen[y * w + x]) continue
      const st = [[x, y]]
      seen[y * w + x] = 1
      let touches = false
      let mnx = x
      let mxx = x
      let mny = y
      let mxy = y
      while (st.length) {
        const [px, py] = st.pop()
        if (px === 0 || py === 0 || px === w - 1 || py === h - 1) touches = true
        if (px < mnx) mnx = px
        if (px > mxx) mxx = px
        if (py < mny) mny = py
        if (py > mxy) mxy = py
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = px + dx
          const ny = py + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          if (seen[ny * w + nx] || m[ny * w + nx]) continue
          seen[ny * w + nx] = 1
          st.push([nx, ny])
        }
      }
      if (!touches) holes++
    }
  }
  return holes
}

function featuresOf(g) {
  const { m, w, h } = g
  let ink = 0
  const colInk = new Array(w).fill(0)
  const rowInk = new Array(h).fill(0)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue
      ink++
      colInk[x]++
      rowInk[y]++
    }
  }
  let stem = 0
  for (const v of colInk) if (v > stem) stem = v
  const top = rowInk[0] ?? 0
  const bottom = rowInk[h - 1] ?? 0
  let topRun = 0
  for (let y = 1; y < Math.max(2, Math.floor(h * 0.4)); y++) topRun = Math.max(topRun, maxRunOfRow(m, w, y))
  let midRun = 0
  for (let y = Math.floor(h * 0.35); y < Math.ceil(h * 0.7); y++) midRun = Math.max(midRun, maxRunOfRow(m, w, y))
  let midRuns = 0
  for (let y = Math.floor(h * 0.35); y < Math.ceil(h * 0.7); y++) midRuns = Math.max(midRuns, runsOfRow(m, w, y))
  // 上下镜像 IoU：3 接近对称（两条弧），2 底部横杠 + 上弧 → 明显不对称
  let inter = 0
  let union = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = m[y * w + x]
      const b = m[(h - 1 - y) * w + x]
      if (a && b) inter++
      if (a || b) union++
    }
  }
  const holes = holesOf(m, w, h)
  // 左右两侧是否有竖笔画贯穿（0 判定用）
  const leftCol = colInk[0] ?? 0
  const rightCol = colInk[w - 1] ?? 0
  return {
    w,
    h,
    ink,
    stem,
    top,
    bottom,
    topRun,
    midRun,
    midRuns,
    holes,
    flip: union ? inter / union : 0,
    leftCol,
    rightCol,
  }
}

/**
 * 结构判定 0–4。针对合成题图中「小字号、抗锯齿」的字形设计；只依赖字形几何：
 *  - 1：底部横杠满宽 + 竖干贯穿 + 上部有横旗
 *  - 2：底部横杠满宽，但没有「1」的竖干/横旗组合
 *  - 3：底部不满宽、无洞（上下两段弧，腰部收窄）
 *  - 0：有洞、底/顶都收窄、左右两侧竖笔画贯穿
 *  - 4：有横杠（中上部的长横）或右上竖干
 */
function structuralDigit(f) {
  const { w, h, stem, top, bottom, topRun, midRun, midRuns, holes, flip, leftCol, rightCol } = f
  const fullBottom = bottom >= w - 0.5
  const fullStem = stem >= h - 1
  if (holes >= 1) {
    const tallHole = holes === 1 && leftCol >= h * 0.5 && rightCol >= h * 0.5
    if (!fullBottom && tallHole) return { digit: 0, conf: 0.9 }
    if (midRun >= w * 0.6) return { digit: 4, conf: 0.7 }
    if (!fullBottom) return { digit: 0, conf: 0.6 }
    return { digit: 4, conf: 0.5 }
  }
  if (fullBottom) {
    if (fullStem && topRun >= Math.max(3, w * 0.5)) return { digit: 1, conf: 0.9 }
    // 4 的开口字形：中上部有长横、右上竖干贯穿
    if (midRun >= w * 0.7 && rightCol >= h * 0.6 && top < w * 0.6) return { digit: 4, conf: 0.5 }
    return { digit: 2, conf: flip < 0.45 ? 0.88 : 0.7 }
  }
  // 底部不满宽
  if (midRun >= w * 0.75 && midRuns === 1 && top < w * 0.75) return { digit: 4, conf: 0.5 }
  if (flip >= 0.5) return { digit: 3, conf: 0.85 }
  return { digit: 3, conf: 0.65 }
}

/* ───────── 数字模板（多字体 / 多字号，交叉校验） ───────── */
const templates = await page.evaluate(
  ({ fonts, weights, sizes, digits }) => {
    const NS = 20
    const cv = document.createElement('canvas')
    cv.width = 120
    cv.height = 120
    const g = cv.getContext('2d', { willReadFrequently: true })
    const norm = (raw, G) => {
      let x0 = G
      let y0 = G
      let x1 = -1
      let y1 = -1
      let ink = 0
      for (let y = 0; y < G; y++) {
        for (let x = 0; x < G; x++) {
          if (!raw[y * G + x]) continue
          ink++
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
      if (!ink) return null
      const bw = x1 - x0 + 1
      const bh = y1 - y0 + 1
      const out = new Uint8Array(NS * NS)
      for (let y = 0; y < NS; y++) {
        for (let x = 0; x < NS; x++) {
          out[y * NS + x] = raw[(y0 + Math.floor((bh * y) / NS)) * G + (x0 + Math.floor((bw * x) / NS))] ? 1 : 0
        }
      }
      return { m: out, aspect: bw / bh }
    }
    const res = []
    for (const font of fonts) {
      for (const weight of weights) {
        for (const size of sizes) {
          for (const ch of digits) {
            g.fillStyle = '#fff'
            g.fillRect(0, 0, 120, 120)
            g.fillStyle = '#000'
            g.font = `${weight} ${size}px "${font}"`
            g.textAlign = 'center'
            g.textBaseline = 'middle'
            g.fillText(ch, 60, 60)
            const dd = g.getImageData(0, 0, 120, 120).data
            const G = 48
            const raw = new Uint8Array(G * G)
            for (let y = 0; y < G; y++) {
              for (let x = 0; x < G; x++) {
                const sx = Math.floor((x * 120) / G)
                const sy = Math.floor((y * 120) / G)
                raw[y * G + x] = dd[(sy * 120 + sx) * 4] < 110 ? 1 : 0
              }
            }
            const n = norm(raw, G)
            if (n) res.push({ ch, m: n.m, aspect: n.aspect })
          }
        }
      }
    }
    return res
  },
  { fonts: DIGIT_FONTS, weights: DIGIT_WEIGHTS, sizes: DIGIT_SIZES, digits: DIGITS },
)

const NS = 20
const simShift = (a, b) => {
  let best = 0
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      let inter = 0
      let union = 0
      for (let y = 0; y < NS; y++) {
        const by = y + dy
        for (let x = 0; x < NS; x++) {
          const av = a[y * NS + x]
          const bx = x + dx
          const bv = by >= 0 && by < NS && bx >= 0 && bx < NS ? b[by * NS + bx] : 0
          if (av && bv) inter++
          if (av || bv) union++
        }
      }
      if (union && inter / union > best) best = inter / union
    }
  }
  return best
}

/** 把字形归一化成 20×20（bbox 拉伸），用于模板比对 */
function normalizeGlyph(g) {
  const { m, w, h } = g
  const out = new Uint8Array(NS * NS)
  for (let y = 0; y < NS; y++) {
    for (let x = 0; x < NS; x++) {
      out[y * NS + x] = m[Math.floor((h * y) / NS) * w + Math.floor((w * x) / NS)] ? 1 : 0
    }
  }
  return out
}

const templateVote = (mask) => {
  const best = new Map()
  for (const t of templates) {
    const s = simShift(mask, t.m)
    const cur = best.get(t.ch) ?? 0
    if (s > cur) best.set(t.ch, s)
  }
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1])
  return { digit: Number(ranked[0][0]), score: ranked[0][1], margin: ranked[0][1] - (ranked[1]?.[1] ?? 0) }
}

/* ───────── 逐顶点识别 → 聚类 → 投票 ───────── */

const { w, h, cells } = detected
console.log(
  `[划斜线识图] ${path.basename(imagePath)}：棋盘 ${w}×${h}，格子 ${detected.cellW.toFixed(1)}×${detected.cellH.toFixed(1)}px`,
)

const glyphs = []
for (let py = 0; py <= h; py++) {
  for (let px = 0; px <= w; px++) {
    const list = cells[py][px]
    if (!list.length) continue
    // 取离顶点中心最近、面积最大的字形
    const named = list.map((g) => ({
      ...g,
      d2: (g.cx - (detected.x0 + px * detected.cellW)) ** 2 + (g.cy - (detected.y0 + py * detected.cellH)) ** 2,
      score: g.ink,
    }))
    if (named.length > 1) {
      named.sort((a, b) => a.d2 - b.d2 || b.score - a.score)
      console.warn(`[划斜线识图] 警告：顶点 (${px},${py}) 出现 ${named.length} 个字形，取最靠近中心的那个`)
    }
    const g = named[0]
    const f = featuresOf(g)
    const st = structuralDigit(f)
    glyphs.push({ px, py, g, f, st })
  }
}

// 相同字形聚类：两两 IoU ≥ 0.92 合并（相同渲染的重复字形会自然成簇）
for (const item of glyphs) item.mask = normalizeGlyph(item.g)
const clusters = []
for (const item of glyphs) {
  let found = -1
  for (const c of clusters) {
    if (simShift(item.mask, c.proto) >= 0.92) {
      found = c.index
      break
    }
  }
  if (found < 0) {
    clusters.push({ index: clusters.length, proto: item.mask, items: [item] })
  } else {
    clusters[found].items.push(item)
  }
}
clusters.forEach((c) => {
  // 簇内投票：结构判定优先，模板作为交叉校验（每簇只比对一次，避免上千次模板匹配）
  const votes = new Map()
  for (const it of c.items) {
    const key = it.st.digit
    votes.set(key, (votes.get(key) ?? 0) + 1)
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1])
  c.digit = ranked[0][0]
  c.agree = ranked[0][1]
  c.total = c.items.length
  const tv = templateVote(c.proto)
  c.templateDigit = tv.digit
  c.templateScore = tv.score
  c.templateAgree = c.digit === tv.digit ? c.total : 0
})
for (const c of clusters) {
  const manual = args.maps[c.index]
  const digit = manual ?? c.digit
  const head = c.items[0]
  const f = head.f
  console.log(
    `[划斜线识图] 数字簇${c.index} → ${digit}（${manual !== undefined ? '人工' : '自动'}，n=${c.total}，` +
      `结构 ${c.digit} ${c.agree}/${c.total}，模板 ${c.templateDigit} 一致 ${c.templateAgree}/${c.total}，` +
      `w=${f.w} h=${f.h} 洞=${f.holes} 底=${f.bottom}/${f.w}）`,
  )
  if (manual === undefined && c.templateDigit !== c.digit && c.templateAgree < c.total * 0.6) {
    console.warn(`[划斜线识图] 注意：簇${c.index} 结构判定 ${c.digit} 与字体模板 ${c.templateDigit} 不一致，可用 --map ${c.index}=数字 修正`)
  }
}

const clues = new Array((w + 1) * (h + 1)).fill(null)
const confList = []
for (const c of clusters) {
  const digit = args.maps[c.index] ?? c.digit
  for (const it of c.items) clues[it.py * (w + 1) + it.px] = digit
}
// 单顶点人工覆盖
for (const [key, v] of Object.entries(args.clueOverrides)) {
  const [px, py] = key.split(',').map(Number)
  if (px < 0 || px > w || py < 0 || py > h) usage(`--clue 坐标越界：${key}（顶点范围 0..${w} × 0..${h}）`)
  clues[py * (w + 1) + px] = v
  console.log(`[划斜线识图] 人工顶点 (${px},${py}) = ${v}`)
}
let clueCount = 0
for (const v of clues) if (v !== null) clueCount++

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
const total = w * h
// 大棋盘用深度探测 + 更大预算；探测通常几十毫秒到几秒就能推满
const probe = total > 400
const budget = args.budget || (probe ? 200_000 : total > 200 ? 6_000_000 : 2_000_000)
const timeBudgetMs = args.timeout ? args.timeout * 1000 : probe ? 300_000 : 240_000
const searchOpts = { maxNodes: budget, timeBudgetMs, probe }
let solutionText = ''
const t0 = Date.now()
const solved = solver.solvePuzzle(puzzle, searchOpts)
if (!solved.solved) {
  if (solved.timedOut) console.warn(`[划斜线识图] 警告：求解超时（${Date.now() - t0}ms），未能给出参考解`)
  else console.warn('[划斜线识图] 警告：识别出的数字无解（可能有数字识别错误，可用 --map / --clue 修正），仍可导入，参考解留空')
} else {
  solutionText = solved.solution.cells.map((c) => (c === 1 ? '\\' : '/')).join('')
  console.log(`[划斜线识图] 找到解（${Date.now() - t0}ms，${solved.nodes} 节点）`)
  if (args.verify) {
    const counted = solver.countSolutions(puzzle, 2, searchOpts)
    if (counted.timedOut) console.warn('[划斜线识图] 警告：唯一性检查超时，未能确认解唯一')
    else if (counted.count > 1) console.warn(`[划斜线识图] 警告：解不唯一（至少 ${counted.count} 个）`)
    else console.log('[划斜线识图] 唯一解 ✓')
  }
}
let unique = null
if (args.verify && solutionText) {
  const counted = solver.countSolutions(puzzle, 2, searchOpts)
  if (!counted.timedOut) unique = counted.count === 1
}

const id = args.id || `gokigen-import-${Date.now().toString(36)}`
const name = args.name || `识图 · ${w}×${h}`
if (args.json) {
  const file = path.resolve(args.json)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify(
      {
        width: w,
        height: h,
        clueCount,
        clues: cluesText,
        solution: solutionText || null,
        unique,
        source: path.basename(imagePath),
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`[划斜线识图] 已导出 JSON：${file}`)
}

if (!args.append) {
  console.log('[划斜线识图] 预览模式，未写入题库。加 --append 写入 src/puzzles-data.ts。')
  process.exit(0)
}

/* ───────── 写入题库 ───────── */
const sol = solutionText ? `, solution: ${JSON.stringify(solutionText)}` : ''
const entry = `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, width: ${w}, height: ${h}, difficulty: "hard", series: ${JSON.stringify(args.series)}, clues: ${JSON.stringify(cluesText)}${sol} },\n`
const dataFile = path.resolve('src/puzzles-data.ts')
if (!existsSync(dataFile)) usage(`找不到题库文件：${dataFile}`)
let text = readFileSync(dataFile, 'utf8').replace(/\r\n/g, '\n')
const marker = text.lastIndexOf('\n]')
if (marker < 0) usage('puzzles-data.ts 格式异常：找不到结尾 ]')
text = text.slice(0, marker + 1) + '\n' + entry + text.slice(marker + 1)
writeFileSync(dataFile, text)
console.log(`[划斜线识图] 已写入 ${dataFile}`)
console.log(`[划斜线识图] id=${id}  name=${name}`)
console.log('[划斜线识图] 注意：npm run gen 会重新生成该文件并覆盖导入内容。')
await browser.close()
