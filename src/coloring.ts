/**
 * 朝向染色 — 约束染色 + 枚举排除（仿 test/数回 的色块染色思路，语义换成「格子朝向」）
 *
 * 把每个格子的两种朝向（\ 与 /）看成两种颜色：
 *   · 某顶点只剩两个未定格、且恰好其中一个必须连向该顶点时——
 *       两格**相邻**（如左上与右上）→ 朝向相同 → 染同色；
 *       两格**对角**（如左上与右下）→ 朝向相反 → 染异色。
 *     原理：相邻格的「连朝方向」一为 \ 一为 /，「恰一连」逼出同向；
 *     对角格的连朝方向相同，「恰一连」逼出反向。
 *   · 约束用带权并查集（parity）传播：同色 parity 0，异色 parity 1，传递闭包自动成立。
 *
 * 主循环（规则 1-4）推不动后由 logic.ts 调用本模块：
 * 剩余未定格各自落入一个颜色类（无约束的格子自成一类），按类枚举
 * （每个类两种整体朝向，共 2^k 种填法），用「顶点数字全对 + 不成环」排除非法填法；
 * 所有合法填法中取值一致的格子即为必然结论，回灌主循环。
 *
 * 墙边无需特例：顶点周围的未定格按实际存在性统计，相邻/对角按实际坐标判断。
 */

import type { CellState, GameState, Puzzle, VertexNumber } from './types'
import { CellState as CS } from './types'
import { cellIndex, clueIndex, vertexIncidents } from './state'
import { validate } from './validate'

/** 枚举上限：颜色类超过这个数就不枚举（best-effort，不硬刚） */
const MAX_CLASSES = 16
/** 枚举时间预算（ms）；超时整体作废——部分枚举结果不可用 */
const ENUM_BUDGET_MS = 1500

/* ———————————————————— 带权并查集（parity DSU） ———————————————————— */

class ParityDSU {
  private readonly parent: Int32Array
  private readonly size: Int32Array
  private readonly diff: Uint8Array // diff[x] = x 到 parent[x] 的颜色位差

  constructor(n: number) {
    this.parent = new Int32Array(n)
    this.size = new Int32Array(n)
    this.diff = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      this.parent[i] = i
      this.size[i] = 1
    }
  }

  /** 找根（带路径压缩；压缩后 diff[x] 即 x 到根的颜色位差） */
  find(x: number): number {
    const path: number[] = []
    let r = x
    while (this.parent[r] !== r) {
      path.push(r)
      r = this.parent[r]!
    }
    let p = 0
    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i]!
      p ^= this.diff[node]!
      this.parent[node] = r
      this.diff[node] = p
    }
    return r
  }

  /** 加约束：a 与 b 的颜色位差为 p（0 同色，1 异色）；矛盾返回 false */
  union(a: number, b: number, p: 0 | 1): boolean {
    const ra = this.find(a)
    const rb = this.find(b)
    const pa = this.diff[a]!
    const pb = this.diff[b]!
    if (ra === rb) return (pa ^ pb) === p
    const d = (pa ^ pb ^ p) as 0 | 1
    if (this.size[ra] < this.size[rb]) {
      this.parent[ra] = rb
      this.diff[ra] = d
      this.size[rb] += this.size[ra]
    } else {
      this.parent[rb] = ra
      this.diff[rb] = d
      this.size[ra] += this.size[rb]
    }
    return true
  }

  /** x 到其根的颜色位（0/1）；内部先做路径压缩 */
  colorBit(x: number): number {
    this.find(x)
    return this.diff[x]!
  }
}

/* ———————————————————— 约束收集 + 枚举 ———————————————————— */

export interface ColoringResult {
  /** 全部合法填法中取值一致的未定格（必然结论） */
  forced: Array<{ cx: number; cy: number; value: CellState }>
  /** 颜色类个数（k，枚举量为 2^k） */
  classes: number
  /** 实际枚举过的填法数 */
  assignments: number
  /** 通过「数字全对 + 不成环」校验的填法数 */
  validCount: number
  /** 超限/超时中止（此时 forced 不可信，调用方应忽略） */
  aborted: boolean
}

interface ColoringBuild {
  dsu: ParityDSU
  /** 未定格线性索引（row-major） */
  unknownIdx: number[]
  /** 约束是否矛盾（奇环） */
  conflict: boolean
}

/** 收集「恰一连」顶点约束并用带权并查集传播，返回着色结构 */
function buildColoring(
  w: number,
  h: number,
  clues: VertexNumber[],
  cells: CellState[],
): ColoringBuild {
  const total = w * h
  const dsu = new ParityDSU(total)
  let conflict = false

  // 1) 收集约束：顶点只剩两个未定格、且恰好其中一个必须连向该顶点
  for (let py = 0; py <= h; py++) {
    for (let px = 0; px <= w; px++) {
      const n = clues[clueIndex(w, px, py)]
      if (n === null || n === undefined) continue
      const incs = vertexIncidents(w, h, px, py)
      let conn = 0
      const unknown: Array<{ cx: number; cy: number }> = []
      for (const inc of incs) {
        const v = cells[cellIndex(w, inc.cx, inc.cy)] ?? CS.Unknown
        if (v === CS.Unknown) unknown.push({ cx: inc.cx, cy: inc.cy })
        else if (v === inc.dir) conn++
      }
      if (unknown.length !== 2) continue
      if (n - conn !== 1) continue // 恰好一个未定格必须连过来（conn < N < conn + 2）
      const [a, b] = unknown as [{ cx: number; cy: number }, { cx: number; cy: number }]
      const adjacent = Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy) === 1
      // 相邻 → 同色；对角 → 异色
      if (!dsu.union(cellIndex(w, a.cx, a.cy), cellIndex(w, b.cx, b.cy), adjacent ? 0 : 1)) {
        conflict = true
      }
    }
  }

  const unknownIdx: number[] = []
  for (let i = 0; i < total; i++) {
    if (cells[i] === CS.Unknown) unknownIdx.push(i)
  }
  return { dsu, unknownIdx, conflict }
}

/**
 * 对当前盘面做朝向染色，并在主循环推不动时用枚举排除推出必然结论。
 * @param w     宽（格数）
 * @param h     高（格数）
 * @param clues 顶点数字，row-major，length = (w+1)*(h+1)
 * @param cells 当前盘面，row-major，length = w*h
 */
export function enumerateColoredCells(
  w: number,
  h: number,
  clues: VertexNumber[],
  cells: CellState[],
): ColoringResult {
  const total = w * h
  const { dsu, unknownIdx, conflict } = buildColoring(w, h, clues, cells)

  // 约束矛盾或没有未定格 → 无线索
  if (conflict || unknownIdx.length === 0) {
    return { forced: [], classes: 0, assignments: 0, validCount: 0, aborted: false }
  }

  // 2) 颜色类编号（根 → 位号）
  const rootBit = new Map<number, number>()
  const rootOf = new Int32Array(total)
  const bit = new Uint8Array(total) // 未定格到其根的颜色位
  for (const i of unknownIdx) {
    const r = dsu.find(i)
    rootOf[i] = r
    bit[i] = dsu.colorBit(i)
    if (!rootBit.has(r)) rootBit.set(r, rootBit.size)
  }
  const classes = rootBit.size
  if (classes > MAX_CLASSES) {
    return { forced: [], classes, assignments: 0, validCount: 0, aborted: true }
  }

  // 3) 枚举：每个颜色类选一个整体朝向（根类颜色 0 → \，1 → /）
  const puzzle: Puzzle = {
    id: 'coloring',
    name: 'coloring',
    width: w,
    height: h,
    clues,
    difficulty: 'custom',
  }
  const state: GameState = { puzzleId: 'coloring', width: w, height: h, cells: cells.slice() }

  const assignments = 1 << classes
  let validCount = 0
  const value = new Uint8Array(total).fill(255) // 255 = 尚未记录
  const disagreed = new Uint8Array(total)
  const t0 = Date.now()

  for (let mask = 0; mask < assignments; mask++) {
    for (const i of unknownIdx) {
      const rootOrient = ((mask >> rootBit.get(rootOf[i]!)!) & 1) === 0 ? CS.Backslash : CS.Slash
      state.cells[i] =
        bit[i] === 0 ? rootOrient : rootOrient === CS.Backslash ? CS.Slash : CS.Backslash
    }
    const v = validate(state, puzzle)
    if (v.badVertices.length === 0 && !v.hasLoop) {
      validCount++
      for (const i of unknownIdx) {
        const val = state.cells[i]!
        if (value[i] === 255) value[i] = val
        else if (value[i] !== val) disagreed[i] = 1 // 出现分歧 → 非必然
      }
    }
    if (Date.now() - t0 > ENUM_BUDGET_MS) {
      return { forced: [], classes, assignments, validCount, aborted: true }
    }
  }

  const forced: Array<{ cx: number; cy: number; value: CellState }> = []
  if (validCount > 0) {
    for (const i of unknownIdx) {
      if (!disagreed[i] && value[i] !== 255) {
        forced.push({ cx: i % w, cy: Math.floor(i / w), value: value[i] as CellState })
      }
    }
  }
  return { forced, classes, assignments, validCount, aborted: false }
}

/* ———————————————————— 染色显示 ———————————————————— */

/** 染色显示标记：一个未定格的底色矩形 */
export interface ColoringMark {
  cx: number
  cy: number
  /** hsl 底色 */
  fill: string
}

/**
 * 计算当前盘面的染色显示（逻辑解题回放时铺在格底，仿数回的色块显示）。
 * 每个未定格按「颜色类 + 类内朝向位」取色：同类同色，类内两种朝向一深一浅，
 * 直观呈现同/异色分组结构。约束矛盾或没有未定格时返回 null。
 */
export function coloringDisplayMarks(
  w: number,
  h: number,
  clues: VertexNumber[],
  cells: CellState[],
): ColoringMark[] | null {
  const { dsu, unknownIdx, conflict } = buildColoring(w, h, clues, cells)
  if (conflict || unknownIdx.length === 0) return null

  // 类编号：按行主序首个出现顺序分配，同一步内稳定
  const classId = new Map<number, number>()
  for (const i of unknownIdx) {
    const r = dsu.find(i)
    if (!classId.has(r)) classId.set(r, classId.size)
  }

  return unknownIdx.map((i) => {
    const id = classId.get(dsu.find(i))!
    const parity = dsu.colorBit(i)
    const hue = (id * 47) % 360 // 近似黄金角扩散，拉开类间色相
    const fill = parity === 0 ? `hsl(${hue}, 62%, 86%)` : `hsl(${hue}, 66%, 71%)`
    return { cx: i % w, cy: Math.floor(i / w), fill }
  })
}
