/**
 * 暴力求解器（回溯 + 剪枝）。
 *
 * 用途：
 *  - 题库生成时校验唯一解（countSolutions）
 *  - 自定义题板的「唯一解校验」
 *
 * 剪枝：
 *  1. 数字顶点：已连数 ≤ 数字，且 已连数 + 尚未定的邻格数 ≥ 数字
 *  2. 环路单调性：一条边把两个已连通的顶点接起来 → 立刻成环 → 剪枝
 *
 * 注意：这是「枚举解」，不是人类逻辑解谜器。人类规则的推理在 src/logic.ts（预留位置）。
 */
import { cellIndex, clueIndex, createEmptyState } from './state'
import type { CellState, GameState, Puzzle, VertexNumber } from './types'
import { CellState as CS } from './types'

export interface SolveResult {
  solved: boolean
  solution: GameState | null
  nodes: number
  timedOut: boolean
}

export interface CountResult {
  count: number
  /** 达到 limit 上限（真实解数可能更多） */
  capped: boolean
  nodes: number
  timedOut: boolean
  first: GameState | null
  second: GameState | null
}

export interface SearchOptions {
  maxNodes?: number
  /** 毫秒；0 表示不限制 */
  timeBudgetMs?: number
}

const DIRS: readonly CellState[] = [CS.Backslash, CS.Slash]

/** 格子四角对应的顶点索引与该角需要的方向 */
function cellVertexDirs(w: number, cx: number, cy: number) {
  return [
    { v: clueIndex(w, cx, cy), dir: CS.Backslash },
    { v: clueIndex(w, cx + 1, cy), dir: CS.Slash },
    { v: clueIndex(w, cx, cy + 1), dir: CS.Slash },
    { v: clueIndex(w, cx + 1, cy + 1), dir: CS.Backslash },
  ] as const
}

class Searcher {
  readonly w: number
  readonly h: number
  readonly clues: VertexNumber[]
  readonly cells: CellState[]
  /** 每个顶点已连的对角线条数 */
  private readonly cnt: Int32Array
  /** 每个顶点周围尚未确定的格子数 */
  private readonly unknownAround: Int32Array
  private readonly parent: Int32Array
  private readonly rank: Int32Array
  private readonly undoStack: Array<[number, number, boolean]> = []
  private readonly maxNodes: number
  private readonly deadline: number
  nodes = 0
  timedOut = false

  constructor(puzzle: Puzzle, opts: SearchOptions = {}) {
    this.w = puzzle.width
    this.h = puzzle.height
    this.clues = puzzle.clues
    this.cells = new Array<CellState>(this.w * this.h).fill(CS.Unknown)
    const vCount = (this.w + 1) * (this.h + 1)
    this.cnt = new Int32Array(vCount)
    this.unknownAround = new Int32Array(vCount)
    this.parent = new Int32Array(vCount)
    this.rank = new Int32Array(vCount)
    for (let i = 0; i < vCount; i++) this.parent[i] = i
    for (let cy = 0; cy < this.h; cy++) {
      for (let cx = 0; cx < this.w; cx++) {
        for (const { v } of cellVertexDirs(this.w, cx, cy)) this.unknownAround[v]!++
      }
    }
    this.maxNodes = opts.maxNodes ?? 400_000
    this.deadline = opts.timeBudgetMs ? Date.now() + opts.timeBudgetMs : 0
  }

  private find(x: number): number {
    let r = x
    while (this.parent[r] !== r) r = this.parent[r]!
    return r
  }

  /** 合并两个端点；返回 false 表示已连通（会成环） */
  private union(a: number, b: number): boolean {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return false
    if (this.rank[ra]! < this.rank[rb]!) {
      this.parent[ra] = rb
      this.undoStack.push([ra, rb, false])
    } else if (this.rank[rb]! < this.rank[ra]!) {
      this.parent[rb] = ra
      this.undoStack.push([rb, ra, false])
    } else {
      this.parent[rb] = ra
      this.rank[ra]!++
      this.undoStack.push([rb, ra, true])
    }
    return true
  }

  private rollback(mark: number): void {
    while (this.undoStack.length > mark) {
      const [child, par, bumped] = this.undoStack.pop()!
      this.parent[child] = child
      if (bumped) this.rank[par]!--
    }
  }

  /** 预检：数字顶点的邻格数不够 → 无解 */
  precheck(): boolean {
    for (let py = 0; py <= this.h; py++) {
      for (let px = 0; px <= this.w; px++) {
        const n = this.clues[clueIndex(this.w, px, py)]
        if (n === null || n === undefined) continue
        if (this.unknownAround[clueIndex(this.w, px, py)]! < n) return false
      }
    }
    return true
  }

  /**
   * 给格子赋值，返回是否可通过剪枝。
   * 约定：本方法总是完整改动状态（cells / cnt / unknownAround / DSU），
   * 由 unassign 无条件完整回滚——避免「提前 return 但调用方仍回滚」造成的计数污染。
   */
  private assign(cx: number, cy: number, dir: CellState): boolean {
    const dirs = cellVertexDirs(this.w, cx, cy)
    let a = -1
    let b = -1
    for (const { v, dir: need } of dirs) {
      if (dir !== need) continue
      if (a < 0) a = v
      else b = v
    }
    // union 在已连通时返回 false 且不做任何改动
    const merged = this.union(a, b)

    this.cells[cellIndex(this.w, cx, cy)] = dir
    for (const { v, dir: need } of dirs) {
      this.unknownAround[v]!--
      if (dir === need) this.cnt[v]!++
    }

    if (!merged) return false // 成环，剪枝

    for (const { v, dir: need } of dirs) {
      if (dir !== need) continue
      const n = this.clues[v]
      if (n === null || n === undefined) continue
      if (this.cnt[v]! > n) return false
      if (this.cnt[v]! + this.unknownAround[v]! < n) return false
    }
    return true
  }

  /** 撤销 assign（dir 必须与 assign 时一致） */
  private unassign(cx: number, cy: number, dir: CellState, mark: number): void {
    this.cells[cellIndex(this.w, cx, cy)] = CS.Unknown
    for (const { v, dir: need } of cellVertexDirs(this.w, cx, cy)) {
      this.unknownAround[v]!++
      if (dir === need) this.cnt[v]!--
    }
    this.rollback(mark)
  }

  private checkBudget(): boolean {
    if (this.nodes > this.maxNodes) {
      this.timedOut = true
      return false
    }
    if (this.deadline && (this.nodes & 2047) === 0 && Date.now() > this.deadline) {
      this.timedOut = true
      return false
    }
    return true
  }

  /** 回溯找一个解；命中 onFound 返回 true 即停 */
  search(onFound: (cells: CellState[]) => boolean): boolean {
    const total = this.w * this.h
    const dfs = (i: number): boolean => {
      if (i === total) return onFound(this.cells.slice())
      this.nodes++
      if (!this.checkBudget()) return true // 超预算：中止整棵搜索树
      const cx = i % this.w
      const cy = Math.floor(i / this.w)
      for (const dir of DIRS) {
        const mark = this.undoStack.length
        if (this.assign(cx, cy, dir)) {
          if (dfs(i + 1)) return true
        }
        this.unassign(cx, cy, dir, mark)
      }
      return false
    }
    return dfs(0)
  }

  toState(puzzle: Puzzle, cells: CellState[]): GameState {
    const st = createEmptyState(puzzle)
    for (let i = 0; i < cells.length; i++) st.cells[i] = cells[i]!
    return st
  }
}

/** 找一个解 */
export function solvePuzzle(puzzle: Puzzle, opts: SearchOptions = {}): SolveResult {
  const s = new Searcher(puzzle, opts)
  if (!s.precheck()) return { solved: false, solution: null, nodes: 0, timedOut: false }
  let found: CellState[] | null = null
  s.search((cells) => {
    found = cells
    return true
  })
  return {
    solved: found !== null,
    solution: found ? s.toState(puzzle, found) : null,
    nodes: s.nodes,
    timedOut: s.timedOut,
  }
}

/** 统计解的个数（上限 limit），用于唯一解校验 */
export function countSolutions(
  puzzle: Puzzle,
  limit = 2,
  opts: SearchOptions = {},
): CountResult {
  const s = new Searcher(puzzle, opts)
  let count = 0
  let first: GameState | null = null
  let second: GameState | null = null
  if (s.precheck()) {
    s.search((cells) => {
      count++
      if (!first) first = s.toState(puzzle, cells)
      else if (!second) second = s.toState(puzzle, cells)
      return count >= limit
    })
  }
  return {
    count,
    capped: count >= limit,
    nodes: s.nodes,
    timedOut: s.timedOut,
    first,
    second,
  }
}

/** 由顶点数字反推：这组数字是否自洽（至少存在一个解） */
export function hasSolution(puzzle: Puzzle, opts: SearchOptions = {}): boolean {
  return solvePuzzle(puzzle, opts).solved
}
