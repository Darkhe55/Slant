import type { GameState, Puzzle, ValidationResult } from './types'
import { CellState as CS } from './types'
import { cellIndex, cellValue, clueIndex } from './state'
import { cellEdgeEndpoints } from './validate'

/** 10×10 基准格距；所有描边/字号按此比例缩放 */
export const BASE_CELL = 48

export interface BoardMetrics {
  cell: number
  pad: number
  width: number
  height: number
  svgWidth: number
  svgHeight: number
  /** 相对 10×10 基准格的缩放 */
  k: number
}

export function metricsFor(puzzle: Puzzle): BoardMetrics {
  const cell = BASE_CELL
  // 数字坐在顶点上，四边也要留出字的空间
  const pad = cell * 0.42
  return {
    cell,
    pad,
    width: puzzle.width,
    height: puzzle.height,
    svgWidth: pad * 2 + puzzle.width * cell,
    svgHeight: pad * 2 + puzzle.height * cell,
    k: cell / BASE_CELL,
  }
}

/** 顶点 (px, py) 的像素坐标 */
export function pointXY(m: BoardMetrics, px: number, py: number) {
  return { x: m.pad + px * m.cell, y: m.pad + py * m.cell }
}

/** 格子中心的像素坐标 */
export function cellCenter(m: BoardMetrics, cx: number, cy: number) {
  return { x: m.pad + (cx + 0.5) * m.cell, y: m.pad + (cy + 0.5) * m.cell }
}

export function clientToViewBox(svg: SVGSVGElement, clientX: number, clientY: number) {
  const ctm = svg.getScreenCTM()
  if (!ctm) return null
  const pt = svg.createSVGPoint()
  pt.x = clientX
  pt.y = clientY
  const p = pt.matrixTransform(ctm.inverse())
  return { x: p.x, y: p.y }
}

/** viewBox 坐标 → 格子索引；越界返回 null */
export function hitTestCell(m: BoardMetrics, puzzle: Puzzle, x: number, y: number): number | null {
  const cx = Math.floor((x - m.pad) / m.cell)
  const cy = Math.floor((y - m.pad) / m.cell)
  if (cx < 0 || cy < 0 || cx >= puzzle.width || cy >= puzzle.height) return null
  return cellIndex(puzzle.width, cx, cy)
}

export interface RenderOptions {
  /** 提示填过的格子（用强调色） */
  hintCells?: Set<number>
}

export function renderBoard(
  puzzle: Puzzle,
  state: GameState,
  result: ValidationResult,
  opts: RenderOptions = {},
): string {
  const m = metricsFor(puzzle)
  const w = puzzle.width
  const h = puzzle.height

  const swOn = 6 * m.k
  const swGuide = 1.6 * m.k
  const rPoint = 3.2 * m.k
  const numSize = 21 * m.k
  const errR = 11 * m.k
  const inset = 2 * m.k

  const badVertexSet = new Set(result.badVertices.map((v) => v.py * (w + 1) + v.px))
  const satisfiedSet = new Set(result.satisfiedVertices)
  const loopSet = new Set(result.loopCells)
  const hintCells = opts.hintCells ?? new Set<number>()

  const parts: string[] = []
  parts.push(
    `<svg class="board-svg" viewBox="0 0 ${m.svgWidth} ${m.svgHeight}" width="${m.svgWidth}" height="${m.svgHeight}" xmlns="http://www.w3.org/2000/svg">`,
  )

  // 盘面底 + 网格导线
  parts.push(
    `<rect class="board-bg" x="${m.pad - inset}" y="${m.pad - inset}" width="${w * m.cell + inset * 2}" height="${h * m.cell + inset * 2}" rx="${10 * m.k}" />`,
  )
  for (let px = 0; px <= w; px++) {
    const x = m.pad + px * m.cell
    parts.push(
      `<line class="grid" x1="${x}" y1="${m.pad}" x2="${x}" y2="${m.pad + h * m.cell}" stroke-width="${swGuide}" />`,
    )
  }
  for (let py = 0; py <= h; py++) {
    const y = m.pad + py * m.cell
    parts.push(
      `<line class="grid" x1="${m.pad}" y1="${y}" x2="${m.pad + w * m.cell}" y2="${y}" stroke-width="${swGuide}" />`,
    )
  }

  // 悬停层（由 updateHover 动态填充，避免整图重绘）
  parts.push('<g class="hover-layer"></g>')

  // 对角线
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const dir = cellValue(state, cellIndex(w, cx, cy))
      if (dir === CS.Unknown) continue
      const e = cellEdgeEndpoints(w, cx, cy, dir)
      const p1 = pointXY(m, e.a % (w + 1), Math.floor(e.a / (w + 1)))
      const p2 = pointXY(m, e.b % (w + 1), Math.floor(e.b / (w + 1)))
      const idx = cellIndex(w, cx, cy)
      const cls = ['diag']
      if (loopSet.has(idx)) cls.push('loop')
      else if (hintCells.has(idx)) cls.push('hint')
      parts.push(
        `<line class="${cls.join(' ')}" data-cell="${idx}" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke-width="${swOn}" />`,
      )
    }
  }

  // 逻辑解题演示高亮层（压在对角线之上、数字之下）
  parts.push('<g class="flash-layer"></g>')

  // 数字不符的顶点画红圈
  for (const v of result.badVertices) {
    const { x, y } = pointXY(m, v.px, v.py)
    parts.push(
      `<circle class="vertex-error" cx="${x}" cy="${y}" r="${errR}" fill="none" stroke-width="${2 * m.k}" />`,
    )
  }

  // 顶点
  for (let py = 0; py <= h; py++) {
    for (let px = 0; px <= w; px++) {
      const { x, y } = pointXY(m, px, py)
      const bad = badVertexSet.has(py * (w + 1) + px)
      parts.push(`<circle class="point${bad ? ' bad' : ''}" cx="${x}" cy="${y}" r="${rPoint}" />`)
    }
  }

  // 顶点数字
  for (let py = 0; py <= h; py++) {
    for (let px = 0; px <= w; px++) {
      const num = puzzle.clues[clueIndex(w, px, py)]
      if (num === null || num === undefined) continue
      const { x, y } = pointXY(m, px, py)
      const bad = badVertexSet.has(py * (w + 1) + px)
      const done = !bad && satisfiedSet.has(py * (w + 1) + px)
      const cls = bad ? 'clue bad' : done ? 'clue done' : 'clue'
      parts.push(
        `<text class="${cls}" x="${x}" y="${y}" style="font-size:${numSize}px">${num}</text>`,
      )
    }
  }

  parts.push('</svg>')
  return parts.join('\n')
}

/* ———————————————————— 悬停预览 ———————————————————— */

/** 悬停层内容：只显示格子高亮背景，不预览下一状态 */
export function hoverMarkup(m: BoardMetrics, cell: number | null): string {
  if (cell === null) return ''
  const cx = cell % m.width
  const cy = Math.floor(cell / m.width)
  const { x, y } = cellCenter(m, cx, cy)
  const inset = 2 * m.k
  return `<rect class="cell-hover" x="${x - m.cell / 2 + inset}" y="${y - m.cell / 2 + inset}" width="${m.cell - inset * 2}" height="${m.cell - inset * 2}" rx="${8 * m.k}" />`
}

/** 只更新悬停层，不重建整张 SVG（保指针事件连续） */
export function updateHover(svg: SVGSVGElement, m: BoardMetrics, cell: number | null): void {
  const layer = svg.querySelector('.hover-layer')
  if (!layer) return
  layer.innerHTML = hoverMarkup(m, cell)
}

/** 逻辑解题演示时「正在推理」的格子高亮 */
export function flashMarkup(m: BoardMetrics, cell: number | null): string {
  if (cell === null) return ''
  const cx = cell % m.width
  const cy = Math.floor(cell / m.width)
  const { x, y } = cellCenter(m, cx, cy)
  const inset = 1 * m.k
  return `<rect class="cell-flash" x="${x - m.cell / 2 + inset}" y="${y - m.cell / 2 + inset}" width="${m.cell - inset * 2}" height="${m.cell - inset * 2}" rx="${8 * m.k}" />`
}

export function updateFlash(svg: SVGSVGElement, m: BoardMetrics, cell: number | null): void {
  const layer = svg.querySelector('.flash-layer')
  if (!layer) return
  layer.innerHTML = flashMarkup(m, cell)
}
