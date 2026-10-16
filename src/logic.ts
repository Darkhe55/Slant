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

/* ———————————————————— 规则 3/4：相邻的 1 与 3 ———————————————————— */

/** 格子 (cx,cy) 取哪个方向，对角线才会连到顶点 (px,py) */
function touchingDir(cx: number, cy: number, px: number, py: number): CellState {
  if (px === cx && py === cy) return CS.Backslash // 顶点是格子左上
  if (px === cx + 1 && py === cy) return CS.Slash // 右上
  if (px === cx && py === cy + 1) return CS.Slash // 左下
  return CS.Backslash // 右下
}

/**
 * 相邻同数字顶点对的四个「非公共格」。
 * 公共格 = 共享 V—Q 那条边的两格；其余四格各只挨着 V 或 Q 之一。
 * 返回 [格子x, 格子y, 归属顶点x, 归属顶点y]
 */
function nonCommonCells(px: number, py: number, qx: number, qy: number) {
  if (qy === py) {
    // 水平相邻 V=(px,py) Q=(px+1,py)
    return [
      [px - 1, py - 1, px, py],
      [px - 1, py, px, py],
      [qx + 1, qy - 1, qx, qy],
      [qx + 1, qy, qx, qy],
    ] as const
  }
  // 垂直相邻 V=(px,py) Q=(px,py+1)
  return [
    [px - 1, py - 1, px, py],
    [px, py - 1, px, py],
    [qx - 1, qy + 1, qx, qy],
    [qx, qy + 1, qx, qy],
  ] as const
}

/**
 * 规则成立的前提：**两个公共格都存在**。
 * 公共格的两个对角端点正是 V 和 Q，所以每格必然连到其中之一——
 * 证明里要用到的就是「两个公共格都连到另一边」这一手。
 * 水平对的公共格在第 py-1 与第 py 行 → 需要 1 ≤ py ≤ h-1；
 * 垂直对的公共格在第 px-1 与第 px 列 → 需要 1 ≤ px ≤ w-1。
 * （顶点贴在墙边时只剩一个公共格，推不出矛盾，规则不适用。）
 */
function pairHasBothCommonCells(
  w: number,
  h: number,
  px: number,
  py: number,
  qx: number,
  qy: number,
): boolean {
  return qy === py ? py >= 1 && py <= h - 1 : px >= 1 && px <= w - 1
}

/**
 * 规则 3 · 相邻的两个 1 → 四个非公共格必须**背朝**各自挨着的那个 1。
 *
 * 证明：设 V、Q 正交相邻且都是 1。每个公共格的两个对角端点正好是 V 和 Q，
 * 所以它必然连到其中之一。若某非公共格连到了 V，V 的额度（1）就用光了，
 * 于是两个公共格都必须避开 V → 都连到 Q → Q 变成 2，矛盾。∎
 *
 * 规则 4 · 相邻的两个 3 → 四个非公共格必须**连朝**各自挨着的那个 3。
 *
 * 证明：若非公共格避开 V，V 想达到 3 就只能让其余三格全连过来，
 * 于是两个公共格都连 V → 都避开 Q → Q 最多从它的两个非公共格拿到 2 < 3，矛盾。∎
 *
 * 墙边处理：越界的格子直接跳过（墙边顶点本来格子就少，推导自然变弱）。
 */
const ruleAdjacentPair: RuleFn = (ctx) => {
  const steps: LogicStep[] = []
  const w = ctx.w
  const h = ctx.h

  for (let py = 0; py <= h; py++) {
    for (let px = 0; px <= w; px++) {
      const n = ctx.clues[clueIndex(w, px, py)]
      if (n !== 1 && n !== 3) continue

      for (const [qx, qy] of [
        [px + 1, py],
        [px, py + 1],
      ] as const) {
        if (qx > w || qy > h) continue
        if (ctx.clues[clueIndex(w, qx, qy)] !== n) continue
        // 墙边前置条件：两个公共格都得在，否则推不出矛盾
        if (!pairHasBothCommonCells(w, h, px, py, qx, qy)) continue

        for (const [cx, cy, vx, vy] of nonCommonCells(px, py, qx, qy)) {
          if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue // 墙边：格子不存在
          const touch = touchingDir(cx, cy, vx, vy)
          const value = n === 1 ? other(touch) : touch
          if (at(ctx, cx, cy) === value) continue // 已经推过
          const ruleNo = n === 1 ? 3 : 4
          const how = n === 1 ? '背朝' : '连朝'
          steps.push(
            put(
              ctx,
              cx,
              cy,
              value,
              `规则${ruleNo} · 顶点 (${px},${py}) 与 (${qx},${qy}) 是相邻的两个 ${n}：非公共格 (${cx},${cy}) 必须${how}它 → 填 ${sym(value)}`,
            ),
          )
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
    id: 'r3-adjacent-ones',
    name: '相邻的两个 1：非公共格背朝（连上去会让另一个 1 变 2）',
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
