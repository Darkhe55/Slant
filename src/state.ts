import type { CellState, GameState, Move, Puzzle } from './types'
import { CellState as CS } from './types'

/* ———————————————————— 索引换算 ———————————————————— */

/** 顶点数组跨度（每行顶点数） */
export function clueStride(w: number): number {
  return w + 1
}

/** 顶点 (px, py) 在 clues 中的扁平索引；px ∈ [0, W]，py ∈ [0, H] */
export function clueIndex(w: number, px: number, py: number): number {
  return py * (w + 1) + px
}

/** 格子 (cx, cy) 在 cells 中的扁平索引；cx ∈ [0, W)，cy ∈ [0, H) */
export function cellIndex(w: number, cx: number, cy: number): number {
  return cy * w + cx
}

/** 格子四角在 clues 中的索引 */
export function cellCorners(w: number, cx: number, cy: number) {
  return {
    tl: clueIndex(w, cx, cy),
    tr: clueIndex(w, cx + 1, cy),
    bl: clueIndex(w, cx, cy + 1),
    br: clueIndex(w, cx + 1, cy + 1),
  }
}

export interface Incident {
  cx: number
  cy: number
  /** 该格取这个方向时，对角线才会连到本顶点 */
  dir: CellState
}

/**
 * 顶点 (px, py) 四周的四格（越界的自动跳过）。
 * 顶点是格子的哪个角，决定了该格需要哪个方向：
 *   - 格 (px-1, py-1) 的右下角 → Backslash
 *   - 格 (px,   py-1) 的左下角 → Slash
 *   - 格 (px-1, py)   的右上角 → Slash
 *   - 格 (px,   py)   的左上角 → Backslash
 */
export function vertexIncidents(
  w: number,
  h: number,
  px: number,
  py: number,
): Incident[] {
  const out: Incident[] = []
  if (px > 0 && py > 0) out.push({ cx: px - 1, cy: py - 1, dir: CS.Backslash })
  if (px < w && py > 0) out.push({ cx: px, cy: py - 1, dir: CS.Slash })
  if (px > 0 && py < h) out.push({ cx: px - 1, cy: py, dir: CS.Slash })
  if (px < w && py < h) out.push({ cx: px, cy: py, dir: CS.Backslash })
  return out
}

/** 所有顶点坐标 */
export function allVertices(w: number, h: number) {
  const pts: Array<{ px: number; py: number }> = []
  for (let py = 0; py <= h; py++) {
    for (let px = 0; px <= w; px++) pts.push({ px, py })
  }
  return pts
}

/** 所有格子坐标 */
export function allCells(w: number, h: number) {
  const cells: Array<{ cx: number; cy: number }> = []
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) cells.push({ cx, cy })
  }
  return cells
}

/** 格子两个端点（对角线两端的顶点索引） */
export function cellEndpoints(w: number, cx: number, cy: number) {
  return {
    a: clueIndex(w, cx, cy),
    b: clueIndex(w, cx + 1, cy + 1),
  }
}

/* ———————————————————— 状态读写 ———————————————————— */

export function createEmptyState(puzzle: Puzzle): GameState {
  return {
    puzzleId: puzzle.id,
    width: puzzle.width,
    height: puzzle.height,
    cells: new Array<CellState>(puzzle.width * puzzle.height).fill(CS.Unknown),
  }
}

export function cellValue(state: GameState, index: number): CellState {
  return state.cells[index] ?? CS.Unknown
}

export function setCell(state: GameState, index: number, value: CellState): void {
  state.cells[index] = value
}

/** 点击循环：未定 → \ → / → 未定（dir = -1 反向） */
export function cycleCell(current: CellState, dir: 1 | -1 = 1): CellState {
  if (current === CS.Unknown) return dir === 1 ? CS.Backslash : CS.Slash
  if (current === CS.Backslash) return dir === 1 ? CS.Slash : CS.Unknown
  return dir === 1 ? CS.Unknown : CS.Backslash
}

export function applyMove(state: GameState, move: Move): void {
  setCell(state, move.index, move.to)
}

export function invertMove(move: Move): Move {
  return { ...move, from: move.to, to: move.from }
}

export function cloneState(state: GameState): GameState {
  return {
    puzzleId: state.puzzleId,
    width: state.width,
    height: state.height,
    cells: state.cells.slice(),
  }
}

/* ———————————————————— 存档 ———————————————————— */

export function serializeState(state: GameState) {
  return {
    version: 1 as const,
    puzzleId: state.puzzleId,
    width: state.width,
    height: state.height,
    cells: state.cells.map((c) => c as number),
    updatedAt: Date.now(),
  }
}

export function deserializeState(data: {
  version: number
  puzzleId: string
  width: number
  height: number
  cells: number[]
}): GameState {
  return {
    puzzleId: data.puzzleId,
    width: data.width,
    height: data.height,
    cells: data.cells.map((n) => n as CellState),
  }
}
