/**
 * 暴力求解器（约束传播 + MRV 回溯）。
 *
 * 用途：
 *  - 题库生成时校验唯一解（countSolutions）
 *  - 自定义题板的「唯一解校验」
 *
 * 剪枝 / 传播：
 *  1. 数字顶点：已连数 ≤ 数字，且 已连数 + 尚未定的邻格数 ≥ 数字；
 *     顶点「已满」→ 其余邻格必须不连该顶点；顶点「必须补满」→ 其余邻格必须连该顶点，
 *     这两类都会立刻确定整格朝向并继续传播。
 *  2. 环路单调性：一条边把两个已连通的顶点接起来 → 立刻成环 → 剪枝。
 *  3. 回溯时用 MRV（可行朝向最少的格子）选分支点；可选 seed 打散同分分支的顺序，
 *     便于对很大的导入题做多轮随机重启。
 *
 * 注意：这是「枚举解」，不是人类逻辑解谜器。人类规则的推理在 src/logic.ts（预留位置）。
 */
import { clueIndex, createEmptyState } from './state'
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
  /** 分支选择随机种子（同分时打散，便于多轮重启）；0/省略 = 不随机 */
  seed?: number
  /**
   * 深度探测：对每个空格分别假设两种朝向再做传播，出现矛盾就确定另一朝向。
   * 对大尺寸导入题（如 50×50）几乎能直接推满，代价是每个搜索节点更贵。
   */
  probe?: boolean
}

/** 各朝向「连到」的角：1 = \（TL,BR），2 = /（TR,BL） */
const ON_TL_BR = 0b1001
const ON_TR_BL = 0b0110

const BIT_BACKSLASH = 1
const BIT_SLASH = 2

class Searcher {
  readonly w: number
  readonly h: number
  readonly total: number
  readonly clues: VertexNumber[]
  readonly cells: Uint8Array
  /** 每个顶点已连的对角线条数 */
  private readonly cnt: Int32Array
  /** 每个顶点周围尚未确定的格子数 */
  private readonly unk: Int32Array
  private readonly parent: Int32Array
  private readonly rank: Int32Array
  /** 每格 4 个顶点的索引，扁平存放（TL/TR/BL/BR） */
  private readonly corner: Int32Array
  /** 回溯栈：依次赋值的格子 */
  private readonly cellTrail: Int32Array
  private cellTrailLen = 0
  /** DSU 回滚栈 */
  private readonly dsuChild: Int32Array
  private readonly dsuParent: Int32Array
  private readonly dsuBump: Uint8Array
  private dsuTrailLen = 0
  private assigned = 0
  private readonly maxNodes: number
  private readonly deadline: number
  nodes = 0
  timedOut = false
  private stopped = false
  /** 随机分支用的 LCG 状态（0 = 不随机） */
  private rng: number
  /** 是否启用深度探测 */
  private readonly probeEnabled: boolean

  constructor(puzzle: Puzzle, opts: SearchOptions = {}) {
    this.w = puzzle.width
    this.h = puzzle.height
    this.total = this.w * this.h
    this.clues = puzzle.clues
    this.cells = new Uint8Array(this.total)
    const vCount = (this.w + 1) * (this.h + 1)
    this.cnt = new Int32Array(vCount)
    this.unk = new Int32Array(vCount)
    this.parent = new Int32Array(vCount)
    this.rank = new Int32Array(vCount)
    for (let i = 0; i < vCount; i++) this.parent[i] = i
    this.maxNodes = opts.maxNodes ?? 400_000
    this.deadline = opts.timeBudgetMs ? Date.now() + opts.timeBudgetMs : 0
    this.rng = opts.seed ? opts.seed >>> 0 || 1 : 0
    this.probeEnabled = !!opts.probe
    this.corner = new Int32Array(this.total * 4)
    for (let cy = 0; cy < this.h; cy++) {
      for (let cx = 0; cx < this.w; cx++) {
        const i = cy * this.w + cx
        const b = i * 4
        this.corner[b] = clueIndex(this.w, cx, cy)
        this.corner[b + 1] = clueIndex(this.w, cx + 1, cy)
        this.corner[b + 2] = clueIndex(this.w, cx, cy + 1)
        this.corner[b + 3] = clueIndex(this.w, cx + 1, cy + 1)
        this.unk[this.corner[b]!]++
        this.unk[this.corner[b + 1]!]++
        this.unk[this.corner[b + 2]!]++
        this.unk[this.corner[b + 3]!]++
      }
    }
    this.cellTrail = new Int32Array(this.total)
    this.dsuChild = new Int32Array(vCount)
    this.dsuParent = new Int32Array(vCount)
    this.dsuBump = new Uint8Array(vCount)
  }

  private rand(): number {
    let x = this.rng
    x ^= x << 13
    x >>>= 0
    x ^= x >> 17
    x ^= x << 5
    x >>>= 0
    this.rng = x || 1
    return this.rng / 2 ** 32
  }

  private find(x: number): number {
    let r = x
    while (this.parent[r] !== r) r = this.parent[r]!
    return r
  }

  /** 合并两个端点；返回 false 表示已连通（会成环） */
  private union(a: number, b: number): boolean {
    let ra = this.find(a)
    let rb = this.find(b)
    if (ra === rb) return false
    if (this.rank[ra]! < this.rank[rb]!) {
      const t = ra
      ra = rb
      rb = t
    }
    this.parent[rb] = ra
    let bumped = 0
    if (this.rank[ra]! === this.rank[rb]!) {
      this.rank[ra]!++
      bumped = 1
    }
    const t = this.dsuTrailLen++
    this.dsuChild[t] = rb
    this.dsuParent[t] = ra
    this.dsuBump[t] = bumped
    return true
  }

  private rollbackCells(mark: number): void {
    while (this.cellTrailLen > mark) {
      const i = this.cellTrail[--this.cellTrailLen]!
      const dir = this.cells[i]!
      this.cells[i] = CS.Unknown
      const b = i * 4
      const v0 = this.corner[b]!
      const v1 = this.corner[b + 1]!
      const v2 = this.corner[b + 2]!
      const v3 = this.corner[b + 3]!
      this.unk[v0]!++
      this.unk[v1]!++
      this.unk[v2]!++
      this.unk[v3]!++
      if (dir === CS.Backslash) {
        this.cnt[v0]!--
        this.cnt[v3]!--
      } else {
        this.cnt[v1]!--
        this.cnt[v2]!--
      }
      this.assigned--
    }
  }

  private rollbackDsu(mark: number): void {
    while (this.dsuTrailLen > mark) {
      const t = --this.dsuTrailLen
      const child = this.dsuChild[t]!
      const par = this.dsuParent[t]!
      this.parent[child] = child
      if (this.dsuBump[t]) this.rank[par]!--
    }
  }

  /** 某朝向（on 位掩码）在给定 4 角下是否可行 */
  private triangleOk(on: number, v0: number, v1: number, v2: number, v3: number): boolean {
    const c0 = this.clues[v0]
    if (c0 !== null && c0 !== undefined) {
      const d = on & 1 ? 1 : 0
      if (this.cnt[v0]! + d > c0) return false
      if (this.cnt[v0]! + d + (this.unk[v0]! - 1) < c0) return false
    }
    const c1 = this.clues[v1]
    if (c1 !== null && c1 !== undefined) {
      const d = on & 2 ? 1 : 0
      if (this.cnt[v1]! + d > c1) return false
      if (this.cnt[v1]! + d + (this.unk[v1]! - 1) < c1) return false
    }
    const c2 = this.clues[v2]
    if (c2 !== null && c2 !== undefined) {
      const d = on & 4 ? 1 : 0
      if (this.cnt[v2]! + d > c2) return false
      if (this.cnt[v2]! + d + (this.unk[v2]! - 1) < c2) return false
    }
    const c3 = this.clues[v3]
    if (c3 !== null && c3 !== undefined) {
      const d = on & 8 ? 1 : 0
      if (this.cnt[v3]! + d > c3) return false
      if (this.cnt[v3]! + d + (this.unk[v3]! - 1) < c3) return false
    }
    // 环路：连接的两个顶点已连通 → 成环 → 该朝向不可行
    if (on === ON_TL_BR) return this.find(v0) !== this.find(v3)
    return this.find(v1) !== this.find(v2)
  }

  /** 该格在当前状态下可行的朝向位掩码（含数字约束与环路约束） */
  private options(i: number): number {
    const b = i * 4
    const v0 = this.corner[b]!
    const v1 = this.corner[b + 1]!
    const v2 = this.corner[b + 2]!
    const v3 = this.corner[b + 3]!
    let mask = 0
    if (this.triangleOk(ON_TL_BR, v0, v1, v2, v3)) mask |= BIT_BACKSLASH
    if (this.triangleOk(ON_TR_BL, v0, v1, v2, v3)) mask |= BIT_SLASH
    return mask
  }

  /** 给格子赋值（假定 options 已确认可行） */
  private assign(i: number, dir: CellState): void {
    const b = i * 4
    const v0 = this.corner[b]!
    const v1 = this.corner[b + 1]!
    const v2 = this.corner[b + 2]!
    const v3 = this.corner[b + 3]!
    this.cells[i] = dir
    this.cellTrail[this.cellTrailLen++] = i
    this.assigned++
    this.unk[v0]!--
    this.unk[v1]!--
    this.unk[v2]!--
    this.unk[v3]!--
    if (dir === CS.Backslash) {
      this.cnt[v0]!++
      this.cnt[v3]!++
      this.union(v0, v3)
    } else {
      this.cnt[v1]!++
      this.cnt[v2]!++
      this.union(v1, v2)
    }
  }

  /** 预检：数字顶点的邻格数不够 → 无解 */
  precheck(): boolean {
    for (let v = 0; v < this.unk.length; v++) {
      const n = this.clues[v]
      if (n === null || n === undefined) continue
      if (this.unk[v]! < n) return false
    }
    return true
  }

  /** 传播到不动点；返回 false 表示矛盾 */
  private propagate(): boolean {
    const total = this.total
    let changed = true
    while (changed) {
      changed = false
      for (let i = 0; i < total; i++) {
        if (this.cells[i] !== CS.Unknown) continue
        const mask = this.options(i)
        if (mask === 0) return false
        if (mask === BIT_BACKSLASH) {
          this.assign(i, CS.Backslash)
          changed = true
        } else if (mask === BIT_SLASH) {
          this.assign(i, CS.Slash)
          changed = true
        }
      }
    }
    return true
  }

  /**
   * 深度探测：对每个空格分别假设「\」「/」再传播一次，出现矛盾即排除该朝向；
   * 只剩一个朝向时立即赋值并继续传播。用于大尺寸导入题的一次性求解 / 唯一性校验。
   * 返回 false 表示矛盾。
   */
  private probePropagate(): boolean {
    const total = this.total
    let changed = true
    while (changed) {
      changed = false
      for (let i = 0; i < total; i++) {
        if (this.cells[i] !== CS.Unknown) continue
        const mask = this.options(i)
        if (mask === 0) return false
        if (mask !== 0b11) {
          // 传播阶段本应已处理，这里兜底
          this.assign(i, mask === BIT_BACKSLASH ? CS.Backslash : CS.Slash)
          changed = true
          continue
        }
        let feasible = 0
        for (const dir of [CS.Backslash, CS.Slash] as const) {
          const mark = this.cellTrailLen
          const dmark = this.dsuTrailLen
          this.assign(i, dir)
          const ok = this.propagate()
          this.rollbackCells(mark)
          this.rollbackDsu(dmark)
          if (ok) feasible |= dir
        }
        if (feasible === 0) return false
        if (feasible !== 0b11) {
          this.assign(i, feasible === BIT_BACKSLASH ? CS.Backslash : CS.Slash)
          changed = true
        }
      }
    }
    return true
  }

  private checkBudget(): boolean {    if (this.nodes > this.maxNodes) {
      this.timedOut = true
      return false
    }
    if (this.deadline && (this.nodes & 1023) === 0 && Date.now() > this.deadline) {
      this.timedOut = true
      return false
    }
    return true
  }

  /** 回溯搜索；命中 onFound 返回 true 即停 */
  search(onFound: (cells: CellState[]) => boolean): void {
    const total = this.total
    const clues = this.clues
    const corner = this.corner
    const randomize = this.rng !== 0

    const dfs = (): void => {
      if (this.stopped) return
      this.nodes++
      if (!this.checkBudget()) {
        this.stopped = true
        return
      }
      if (!this.propagate()) return
      if (this.probeEnabled && !this.probePropagate()) return
      if (this.assigned === total) {
        const snapshot = new Array<CellState>(total)
        for (let i = 0; i < total; i++) snapshot[i] = this.cells[i] as CellState
        if (onFound(snapshot)) this.stopped = true
        return
      }
      // MRV：选可行朝向最少、且贴邻已紧数字最多的空格
      let best = -1
      let bestScore = -1
      let ties: number[] = []
      for (let i = 0; i < total; i++) {
        if (this.cells[i] !== CS.Unknown) continue
        const mask = this.options(i)
        if (mask === 0) return
        if (mask !== 0b11) continue
        const b = i * 4
        let score = 0
        const c0 = clues[corner[b]!]
        if (c0 !== null && c0 !== undefined) score += 2 + (4 - c0)
        const c1 = clues[corner[b + 1]!]
        if (c1 !== null && c1 !== undefined) score += 2 + (4 - c1)
        const c2 = clues[corner[b + 2]!]
        if (c2 !== null && c2 !== undefined) score += 2 + (4 - c2)
        const c3 = clues[corner[b + 3]!]
        if (c3 !== null && c3 !== undefined) score += 2 + (4 - c3)
        if (score > bestScore) {
          bestScore = score
          best = i
          ties.length = 0
          ties.push(i)
        } else if (score === bestScore) {
          ties.push(i)
        }
      }
      if (best < 0) return
      if (randomize && ties.length > 1) {
        // 高分格中随机挑一个，避免大棋盘上固定顺序反复撞同一棵子树
        const idx = Math.floor(this.rand() * ties.length)
        best = ties[idx]!
      }
      const mark = this.cellTrailLen
      const dmark = this.dsuTrailLen
      const first = randomize && this.rand() < 0.5 ? CS.Slash : CS.Backslash
      for (let t = 0; t < 2; t++) {
        const dir = t === 0 ? first : first === CS.Backslash ? CS.Slash : CS.Backslash
        this.assign(best, dir)
        dfs()
        this.rollbackCells(mark)
        this.rollbackDsu(dmark)
        if (this.stopped) return
      }
    }
    dfs()
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
