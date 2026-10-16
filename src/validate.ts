import { allVertices, cellIndex, cellValue, clueIndex, vertexIncidents } from './state'
import type { CellState, GameState, Puzzle, ValidationResult, VertexCount } from './types'
import { CellState as CS } from './types'

/** 格子填入后，对角线的两个端点（顶点索引） */
export function cellEdgeEndpoints(w: number, cx: number, cy: number, dir: CellState) {
  return dir === CS.Slash
    ? { a: clueIndex(w, cx + 1, cy), b: clueIndex(w, cx, cy + 1) }
    : { a: clueIndex(w, cx, cy), b: clueIndex(w, cx + 1, cy + 1) }
}

/** 顶点上经过的对角线条数（只看已填格子） */
export function degreeAt(state: GameState, px: number, py: number): number {
  const bw = state.width
  const bh = state.height
  let d = 0
  for (const inc of vertexIncidents(bw, bh, px, py)) {
    if (cellValue(state, cellIndex(bw, inc.cx, inc.cy)) === inc.dir) d++
  }
  return d
}

export interface LoopInfo {
  hasLoop: boolean
  /** 成环涉及的格子索引 */
  loopCells: number[]
}

/**
 * 环路检测：把每条对角线看成「顶点—顶点」的一条边。
 *
 * 无向图中，连通分量满足 边数 ≥ 顶点数 时必然含环；
 * 且「有环」是单调的——再加边不会消除环，所以这个判定也能直接给解题器当剪枝。
 */
export function analyzeLoop(state: GameState, w: number, h: number): LoopInfo {
  const vCount = (w + 1) * (h + 1)
  const parent = new Int32Array(vCount)
  const rank = new Int32Array(vCount)
  for (let i = 0; i < vCount; i++) parent[i] = i

  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]!
    while (parent[x] !== r) {
      const next = parent[x]!
      parent[x] = r
      x = next
    }
    return r
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    if (rank[ra]! < rank[rb]!) parent[ra] = rb
    else if (rank[ra]! > rank[rb]!) parent[rb] = ra
    else {
      parent[rb] = ra
      rank[ra]!++
    }
  }

  // 收集所有已填格子的边
  const edges: Array<{ a: number; b: number; cell: number }> = []
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const dir = cellValue(state, cellIndex(w, cx, cy))
      if (dir === CS.Unknown) continue
      const { a, b } = cellEdgeEndpoints(w, cx, cy, dir)
      edges.push({ a, b, cell: cellIndex(w, cx, cy) })
      union(a, b)
    }
  }

  const edgeCount = new Int32Array(vCount)
  const vertCount = new Int32Array(vCount)
  const stamp = new Int32Array(vCount).fill(-1)

  for (const e of edges) {
    const r = find(e.a)
    edgeCount[r]!++
    if (stamp[e.a] !== r) {
      stamp[e.a] = r
      vertCount[r]!++
    }
    if (stamp[e.b] !== r) {
      stamp[e.b] = r
      vertCount[r]!++
    }
  }

  const cyclicRoots = new Set<number>()
  for (let v = 0; v < vCount; v++) {
    if (find(v) !== v) continue
    if (vertCount[v]! > 0 && edgeCount[v]! >= vertCount[v]!) cyclicRoots.add(v)
  }

  const loopCells: number[] = []
  if (cyclicRoots.size) {
    for (const e of edges) {
      if (cyclicRoots.has(find(e.a))) loopCells.push(e.cell)
    }
  }

  return { hasLoop: cyclicRoots.size > 0, loopCells }
}

/* ———————————————————— 校验 ———————————————————— */

export function validate(state: GameState, puzzle: Puzzle): ValidationResult {
  const w = puzzle.width
  const h = puzzle.height

  const badVertices: VertexCount[] = []
  const satisfiedVertices: number[] = []
  let filled = 0

  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      if (cellValue(state, cellIndex(w, cx, cy)) !== CS.Unknown) filled++
    }
  }

  for (const { px, py } of allVertices(w, h)) {
    const idx = py * (w + 1) + px
    const expected = puzzle.clues[idx] ?? null
    if (expected === null || expected === undefined) continue
    const actual = degreeAt(state, px, py)
    if (actual === expected) {
      satisfiedVertices.push(idx)
      continue
    }
    // 周围还没定的格子数：决定「还差几条」是否还补得上
    let unknownAround = 0
    for (const inc of vertexIncidents(w, h, px, py)) {
      if (cellValue(state, cellIndex(w, inc.cx, inc.cy)) === CS.Unknown) unknownAround++
    }
    if (actual > expected) {
      badVertices.push({ px, py, expected, actual, kind: 'over' })
    } else if (actual + unknownAround < expected) {
      badVertices.push({ px, py, expected, actual, kind: 'stuck' })
    }
    // 其余情况属于「还在推进中」，不算错
  }

  const loop = analyzeLoop(state, w, h)
  const unknown = w * h - filled
  const solved = unknown === 0 && badVertices.length === 0 && !loop.hasLoop

  return {
    badVertices,
    satisfiedVertices,
    filled,
    unknown,
    hasLoop: loop.hasLoop,
    loopCells: loop.loopCells,
    solved,
  }
}
