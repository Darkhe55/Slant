/**
 * 逻辑解谜器（人类规则推理）
 * =====================
 *
 * 不枚举所有解，而是像人一样一步步推出必然结论，每一步都能说清理由，
 * 由 main.ts 逐条动画播放（也能直接采用整份结论）。
 *
 * 已实现：
 *   规则 1 · 顶点饱和度
 *     - 1a 数字的「连接数」已足够（conn === N）→ 剩余未定格全部填「背朝」方向
 *     - 1b 数字的「非连接数」已占满额度（conn + unk === N，即 off === k - N）
 *          → 剩余未定格全部填「连朝」方向
 *
 *   规则 2 · 环路规避
 *     - 某格填 A 方向会把两个「已经连通」的顶点接起来 → 立刻闭合成环 → 只能填 B
 *       （有环是单调的：加边不会消环，所以试填后成环 = 该方向永久非法）
 *
 *   规则 3 · 相邻的两个 1（ruleAdjacentPair，n = 1）
 *     - 两个 1 正交相邻时，四个「非公共格」必须背朝各自挨着的那个 1
 *     - 证明：公共格的两个对角端点正是这两个 1，必然连到其中一个；
 *       若非公共格连到 V，V 额度用光 → 两个公共格都避开 V → 都连到 Q → Q 变 2，矛盾
 *
 *   规则 4 · 相邻的两个 3（ruleAdjacentPair，n = 3）
 *     - 完全对称：四个非公共格必须连朝各自挨着的那个 3
 *     - 证明：若非公共格避开 V，V 要达到 3 就得让其余三格全连 → 两个公共格都连 V
 *       → 都避开 Q → Q 最多 2 < 3，矛盾
 *
 * 关于「一条直线上除了两端点外都是 2 ⟹ 两端点连通」：
 *   这条**不成立**，不能当规则用。反例（4×4，主对角线上 (1,1)(2,2) 都是 2，
 *   其余无数字）存在完整合法解使 (0,0) 与 (3,3) 分属两条链：
 *      \ / \ \      中间的链在 (1,1) 那一格拐去了别处，并没有把两端点连起来
 *      \ / \ \      （每个内部 2 都可以从「斜线那格」逃逸到线外，链路不必沿线走）
 *      \ / \ \
 *      \ \ \ \
 *   若要实现「2 链连通性」，需要做全图连通分量跟踪 + 假设推演，不是单条局部规则。
 *
 * 待实现（往 RULES 里加即可）：
 *   5. 单格二选一 + 传播：假设某格填 A，跑一遍规则 1-4 不动点，出现矛盾则填 B
 *   6. 全图连通分量跟踪（配合规则 2 做跨单元格的环路预判）
 */
import { cellIndex, clueIndex, vertexIncidents } from './state'
import { cellEdgeEndpoints } from './validate'
import { enumerateColoredCells } from './coloring'
import type { CellState, GameState, LogicStep, Puzzle, VertexNumber } from './types'
import { CellState as CS } from './types'

export interface LogicPlan {
  /** 是否已实现推理能力 */
  supported: boolean
  /** 不支持时的原因（展示给用户） */
  reason: string
  /** 推理步骤（可空） */
  steps: LogicStep[]
  /** 步骤是否推出完整解 */
  complete: boolean
  /** 耗时（毫秒） */
  ms: number
  /** 推理结束后的格子状态（ steps 全部采用后的结果） */
  cells: CellState[]
  /** 推理中发现的矛盾（说明当前盘面填错了/无解） */
  conflicts: string[]
}

export interface RuleCtx {
  w: number
  h: number
  clues: VertexNumber[]
  /** 可变工作副本：规则边推边落子，同一轮里后续规则/后续顶点立即可见 */
  cells: CellState[]
  conflicts: string[]
}

export type RuleFn = (ctx: RuleCtx) => LogicStep[]

export interface RuleMeta {
  id: string
  name: string
  fn: RuleFn
}

const other = (dir: CellState): CellState =>
  dir === CS.Backslash ? CS.Slash : CS.Backslash

const sym = (v: CellState): string => (v === CS.Backslash ? '\\' : '/')

const at = (ctx: RuleCtx, cx: number, cy: number): CellState =>
  ctx.cells[cellIndex(ctx.w, cx, cy)] ?? CS.Unknown

const put = (ctx: RuleCtx, cx: number, cy: number, value: CellState, reason: string): LogicStep => {
  const index = cellIndex(ctx.w, cx, cy)
  const cur = ctx.cells[index]
  if (cur !== CS.Unknown && cur !== value) {
    ctx.conflicts.push(`格子 (${cx},${cy}) 推断冲突：已是 ${sym(cur)}，又推出 ${sym(value)}`)
  }
  ctx.cells[index] = value
  return { cell: index, value, reason }
}

/* ———————————————————— 规则 1：顶点饱和度 ———————————————————— */

/**
 * 对每个带数字的顶点，数一数它周围四格：
 *   conn = 已填成「连朝本顶点」的格数
 *   off  = 已填成「背朝本顶点」的格数
 *   unk  = 还没定的格数        （k = conn + off + unk = 周围格子总数）
 *
 * 1a  conn === N            → 连接数已够，剩余 unk 格只能背朝
 * 1b  conn + unk === N      → 想达到 N 必须把剩余 unk 格全连过来
 *                            （等价于 off === k - N，即「非连接数」已和数字互补）
 */
const ruleVertexSaturation: RuleFn = (ctx) => {
  const steps: LogicStep[] = []

  for (let py = 0; py <= ctx.h; py++) {
    for (let px = 0; px <= ctx.w; px++) {
      const n = ctx.clues[clueIndex(ctx.w, px, py)]
      if (n === null || n === undefined) continue

      const incs = vertexIncidents(ctx.w, ctx.h, px, py)
      const pending: Array<{ cx: number; cy: number; need: CellState }> = []
      let conn = 0
      let off = 0

      for (const inc of incs) {
        const v = at(ctx, inc.cx, inc.cy)
        if (v === CS.Unknown) pending.push({ cx: inc.cx, cy: inc.cy, need: inc.dir })
        else if (v === inc.dir) conn++
        else off++
      }

      if (conn > n) {
        ctx.conflicts.push(
          `顶点 (${px},${py}) 的数字是 ${n}，但已经有 ${conn} 条斜线连过来`,
        )
        continue
      }
      if (!pending.length) continue

      if (conn === n) {
        // 1a：连接数已足够 → 剩余全部背朝该顶点
        const head = `规则1 · 顶点 (${px},${py}) 数字 ${n}：已有 ${conn} 条连过，剩余 ${pending.length} 格必须背朝它`
        for (const p of pending) {
          steps.push(put(ctx, p.cx, p.cy, other(p.need), `${head} → 填 ${sym(other(p.need))}`))
        }
      } else if (conn + pending.length === n) {
        // 1b：非连接数已和数字互补 → 剩余必须全部连朝该顶点
        const head = `规则1 · 顶点 (${px},${py}) 数字 ${n}：已有 ${conn} 条、${off} 格背朝，剩余 ${pending.length} 格必须连过来`
        for (const p of pending) {
          steps.push(put(ctx, p.cx, p.cy, p.need, `${head} → 填 ${sym(p.need)}`))
        }
      }
    }
  }

  return steps
}

/* ———————————————————— 规则 2：环路规避 ———————————————————— */

/** 并查集：用来判断「两个顶点是否已经连通」 */
class LoopGuard {
  private readonly parent: Int32Array
  private readonly rank: Int32Array

  constructor(vCount: number) {
    this.parent = new Int32Array(vCount)
    this.rank = new Int32Array(vCount)
    for (let i = 0; i < vCount; i++) this.parent[i] = i
  }

  private find(x: number): number {
    let r = x
    while (this.parent[r] !== r) r = this.parent[r]!
    while (this.parent[x] !== r) {
      const next = this.parent[x]!
      this.parent[x] = r
      x = next
    }
    return r
  }

  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    if (this.rank[ra]! < this.rank[rb]!) this.parent[ra] = rb
    else if (this.rank[rb]! < this.rank[ra]!) this.parent[rb] = ra
    else {
      this.parent[rb] = ra
      this.rank[ra]!++
    }
  }

  /** 已经连通 → 再接一条就会成环 */
  closesLoop(a: number, b: number): boolean {
    return this.find(a) === this.find(b)
  }
}

/**
 * 对每个未定格子分别试填两个方向：只要某个方向会把两个已连通的顶点接上
 * （立刻闭合成环），该方向就非法；另一个方向随之确定。
 *
 * 实现上一次建好并查集（把已填格子全并起来），之后每格只需两次 find，
 * 推出来的格子当场并回去，同轮后续格子立即可见。
 */
const ruleLoopAvoidance: RuleFn = (ctx) => {
  const steps: LogicStep[] = []
  const guard = new LoopGuard((ctx.w + 1) * (ctx.h + 1))

  // 1) 已填格子先入图
  for (let cy = 0; cy < ctx.h; cy++) {
    for (let cx = 0; cx < ctx.w; cx++) {
      const v = at(ctx, cx, cy)
      if (v === CS.Unknown) continue
      const e = cellEdgeEndpoints(ctx.w, cx, cy, v)
      guard.union(e.a, e.b)
    }
  }

  // 2) 逐个未定格试填
  for (let cy = 0; cy < ctx.h; cy++) {
    for (let cx = 0; cx < ctx.w; cx++) {
      if (at(ctx, cx, cy) !== CS.Unknown) continue
      const back = cellEdgeEndpoints(ctx.w, cx, cy, CS.Backslash)
      const slash = cellEdgeEndpoints(ctx.w, cx, cy, CS.Slash)
      const backDies = guard.closesLoop(back.a, back.b)
      const slashDies = guard.closesLoop(slash.a, slash.b)

      if (backDies && slashDies) {
        ctx.conflicts.push(`格子 (${cx},${cy}) 两个方向都会闭合成环，此题无解`)
        continue
      }
      if (backDies) {
        steps.push(
          put(
            ctx,
            cx,
            cy,
            CS.Slash,
            `规则2 · 格子 (${cx},${cy}) 填 \\ 会和已有斜线闭合成环 → 只能填 /`,
          ),
        )
        guard.union(slash.a, slash.b)
      } else if (slashDies) {
        steps.push(
          put(
            ctx,
            cx,
            cy,
            CS.Backslash,
            `规则2 · 格子 (${cx},${cy}) 填 / 会和已有斜线闭合成环 → 只能填 \\`,
          ),
        )
        guard.union(back.a, back.b)
      }
    }
  }

  return steps
}

/* ———————————————————— 规则 3/4：相邻数字对的非公共格推导 ———————————————————— */

/** 格子 (cx,cy) 取哪个方向，对角线才会连到顶点 (px,py) */
function touchingDir(cx: number, cy: number, px: number, py: number): CellState {
  if (px === cx && py === cy) return CS.Backslash // 顶点是格子左上
  if (px === cx + 1 && py === cy) return CS.Slash // 右上
  if (px === cx && py === cy + 1) return CS.Slash // 左下
  return CS.Backslash // 右下
}

/** 顶点四邻的格子，带「归属顶点」标记 */
function cellsOfVertex(vx: number, vy: number): Array<[number, number, number, number]> {
  return [
    [vx - 1, vy - 1, vx, vy],
    [vx, vy - 1, vx, vy],
    [vx - 1, vy, vx, vy],
    [vx, vy, vx, vy],
  ]
}

/**
 * 相邻顶点对 V—Q 的格子分组（只收盘面内真实存在的格子）：
 *   g         = 公共格数（两个对角端点正是 V 和 Q 的格子，每格必连向二者之一）
 *   nonCommon = 非公共格 [cx, cy, 归属顶点x, 归属顶点y]
 * 贴墙时自然变少：顶边/底边的水平对只剩 1 个公共格，墙边顶点可能只剩 0–2 个非公共格。
 */
function pairCells(w: number, h: number, px: number, py: number, qx: number, qy: number) {
  const inBoard = (c: readonly number[]) => c[0] >= 0 && c[1] >= 0 && c[0] < w && c[1] < h
  const vCells = cellsOfVertex(px, py).filter(inBoard)
  const qCells = cellsOfVertex(qx, qy).filter(inBoard)
  const key = (c: readonly number[]) => `${c[0]},${c[1]}`
  const qSet = new Set(qCells.map(key))
  const vSet = new Set(vCells.map(key))
  const vOnly = vCells.filter((c) => !qSet.has(key(c)))
  const qOnly = qCells.filter((c) => !vSet.has(key(c)))
  return { g: vCells.length - vOnly.length, nonCommon: [...vOnly, ...qOnly] }
}

/**
 * 规则 3/4 · 相邻数字对的非公共格额度推导（「相邻的 1 / 相邻的 3」的推广）。
 *
 * 设 V、Q 正交相邻，数字 N1、N2，S = N1 + N2。任一完整解都满足恒等式
 *   S = g +（非公共格连向各自归属顶点的条数）
 * ——每个公共格必连向 V/Q 之一，每个非公共格至多连向它归属的那个顶点。
 * 记 c = 已确认相连的非公共格数、b = 已确认相背数、n = 非公共格总数，
 * g、n 一律按盘面内实际存在的格子代入（贴墙自动弱化）：
 *
 *   规则 3（相背）：c + g ≥ S → 连接额度已用光，剩余空格再连就超支 → 全部填相背；
 *   规则 4（相连）：b = n + g − S（墙内完整时即 b + 2 + S = 8）
 *                → 相背数把余量吃光，剩余空格必须全部相连才够 S → 全部填相连。
 *
 * 特例回归：相邻两个 1（S=2, g=2）→ c ≥ 0 恒成立 → 非公共格全相背；
 * 相邻两个 3（S=6, g=2, n=4）→ b = 0 即触发 → 非公共格全相连。
 * 墙边示例：角上相邻两个 1（(0,0)-(1,0)，g=1, n=1）→ b = 0 触发规则 4，
 * 唯一非公共格必须相连（另一个顶点的额度被它仅有的格子占满）。
 */
const ruleAdjacentPair: RuleFn = (ctx) => {
  const steps: LogicStep[] = []
  const w = ctx.w
  const h = ctx.h

  for (let py = 0; py <= h; py++) {
    for (let px = 0; px <= w; px++) {
      const n1 = ctx.clues[clueIndex(w, px, py)]
      if (n1 === null || n1 === undefined) continue

      for (const [qx, qy] of [
        [px + 1, py],
        [px, py + 1],
      ] as const) {
        if (qx > w || qy > h) continue
        const n2 = ctx.clues[clueIndex(w, qx, qy)]
        if (n2 === null || n2 === undefined) continue
        const s = n1 + n2

        const { g, nonCommon } = pairCells(w, h, px, py, qx, qy)
        const n = nonCommon.length
        if (!n) continue

        // 统计非公共格的已确认状态，收集待推空格
        let connected = 0
        let away = 0
        const pending: Array<{ cx: number; cy: number; touch: CellState }> = []
        for (const [cx, cy, vx, vy] of nonCommon) {
          const touch = touchingDir(cx, cy, vx, vy)
          const v = at(ctx, cx, cy)
          if (v === touch) connected++
          else if (v === other(touch)) away++
          else pending.push({ cx, cy, touch })
        }
        if (!pending.length) continue

        const label = `顶点 (${px},${py}) 与 (${qx},${qy}) 是相邻的 ${n1} 和 ${n2}`

        if (connected + g >= s) {
          // 规则 3：连接额度已用光 → 剩余全部相背
          const head = `规则3 · ${label}：非公共格已连 ${connected} 条 + 公共格 ${g} 条 ≥ 两数之和 ${s}，剩余 ${pending.length} 格必须相背`
          for (const p of pending) {
            const value = other(p.touch)
            steps.push(put(ctx, p.cx, p.cy, value, `${head} → 填 ${sym(value)}`))
          }
          continue
        }

        if (away === n + g - s) {
          // 规则 4：相背数把余量吃光 → 剩余全部相连
          const head = `规则4 · ${label}：非公共格已相背 ${away} 格，必须全部相连才够 ${s} → 剩余 ${pending.length} 格填相连`
          for (const p of pending) {
            steps.push(put(ctx, p.cx, p.cy, p.touch, `${head} → 填 ${sym(p.touch)}`))
          }
        }
      }
    }
  }

  return steps
}

/* ———————————————————— 规则表 ———————————————————— */

export const RULES: RuleMeta[] = [
  {
    id: 'r1-vertex-saturation',
    name: '顶点饱和度：连够→其余背朝；背够→其余连来',
    fn: ruleVertexSaturation,
  },
  {
    id: 'r2-loop-avoidance',
    name: '环路规避：某方向会闭合已有链路 → 只能填另一个',
    fn: ruleLoopAvoidance,
  },
  {
    id: 'r3-adjacent-pair',
    name: '相邻数字对：非公共格额度推导（已连+公共格 ≥ 两数之和 → 其余相背；相背吃光余量 → 其余相连）',
    fn: ruleAdjacentPair,
  },
]

/* ———————————————————— 主循环 ———————————————————— */

function initialCells(puzzle: Puzzle, start?: GameState | CellState[]): CellState[] {
  const total = puzzle.width * puzzle.height
  const empty = () => new Array<CellState>(total).fill(CS.Unknown)
  if (!start) return empty()
  if (Array.isArray(start)) {
    return start.length === total ? start.slice() : empty()
  }
  if (start.width === puzzle.width && start.height === puzzle.height) {
    return start.cells.slice()
  }
  return empty()
}

/* ———————————————————— 规则 5：染色枚举（主循环推不动时启用） ———————————————————— */

/**
 * 规则 5 · 朝向染色枚举（仿数回色块染色）：
 * 剩余未定格按「同/异色」约束（同一顶点恰一连的相邻格 → 同色，对角格 → 异色）
 * 用带权并查集传播，再按颜色类枚举整体朝向，用「顶点数字全对 + 不成环」排除非法填法；
 * 全部合法填法中取值一致的格子即为必然结论。
 */
function ruleColoringEnumerate(ctx: RuleCtx): LogicStep[] {
  const r = enumerateColoredCells(ctx.w, ctx.h, ctx.clues, ctx.cells)
  if (r.aborted || !r.forced.length) return []
  const head = `规则5 · 染色枚举：剩余格分属 ${r.classes} 个同/异色类，${r.assignments} 种填法中 ${r.validCount} 种通过「数字全对 + 不成环」校验`
  return r.forced.map((f) =>
    put(
      ctx,
      f.cx,
      f.cy,
      f.value,
      `${head}，格子 (${f.cx},${f.cy}) 在全部合法填法中取值一致 → 填 ${sym(f.value)}`,
    ),
  )
}

/**
 * 逻辑解谜器入口。
 * @param puzzle 题面
 * @param start  起始盘面（玩家当前进度）；不传则从空盘开始
 */
export function planLogicSolve(puzzle: Puzzle, start?: GameState | CellState[]): LogicPlan {
  const t0 = Date.now()
  const w = puzzle.width
  const h = puzzle.height

  const ctx: RuleCtx = {
    w,
    h,
    clues: puzzle.clues,
    cells: initialCells(puzzle, start),
    conflicts: [],
  }

  const steps: LogicStep[] = []
  let progress = true
  let guard = 0

  // 主循环：只要有规则推出新结论，就从头再扫一遍（新结论会解锁更多推理）
  while (progress && !ctx.conflicts.length) {
    if (++guard > 10_000) {
      ctx.conflicts.push('推理步数异常，已中止')
      break
    }
    progress = false
    for (const rule of RULES) {
      const produced = rule.fn(ctx)
      if (produced.length) {
        steps.push(...produced)
        progress = true
      }
      if (ctx.conflicts.length) break
    }
    // 规则 1-4 推不动 → 染色枚举（带权并查集传播 + 按类枚举 + 成环/数字校验排除）
    if (!progress && !ctx.conflicts.length) {
      const produced = ruleColoringEnumerate(ctx)
      if (produced.length) {
        steps.push(...produced)
        progress = true
      }
    }
  }

  const complete = ctx.cells.every((c) => c !== CS.Unknown)

  return {
    supported: true,
    reason: '',
    steps,
    complete,
    ms: Date.now() - t0,
    cells: ctx.cells.slice(),
    conflicts: ctx.conflicts.slice(),
  }
}
