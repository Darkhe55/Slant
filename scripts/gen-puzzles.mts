/**
 * 一次性生成静态题库 → src/puzzles-data.ts
 * 运行时只读数据，不在 import 时跑生成/求解。
 *
 * 用法：npm run gen
 *   （内部：esbuild 打包成 scripts/gen-puzzles.mjs 后 node 执行）
 *
 * 生成流程：
 *   1. 随机造一个「无环」的完整填法（DFS + 环检测）
 *   2. 由填法算出每个顶点的数字 → 全数字题（必然唯一解）
 *   3. 随机删数字，每删一个都用 countSolutions 校验「仍唯一解」，否则回滚
 *   4. 落盘：顶点数字串 + 参考解串
 */
import { countSolutions } from '../src/solver.ts'
import type { CellState, Puzzle, VertexNumber } from '../src/types'
import { CellState as CS } from '../src/types'
import { writeFileSync } from 'node:fs'

/* ———————————————————— 随机数 ———————————————————— */

function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = a[i]!
    a[i] = a[j]!
    a[j] = tmp
  }
  return a
}

/* ———————————————————— 随机无环解 ———————————————————— */

class DSU {
  parent: Int32Array
  rank: Int32Array
  stack: Array<[number, number, boolean]> = []
  constructor(n: number) {
    this.parent = new Int32Array(n)
    this.rank = new Int32Array(n)
    for (let i = 0; i < n; i++) this.parent[i] = i
  }
  find(x: number): number {
    let r = x
    while (this.parent[r] !== r) r = this.parent[r]!
    return r
  }
  /** 返回 false = 已连通（会成环） */
  union(a: number, b: number): boolean {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return false
    if (this.rank[ra]! < this.rank[rb]!) {
      this.parent[ra] = rb
      this.stack.push([ra, rb, false])
    } else if (this.rank[rb]! < this.rank[ra]!) {
      this.parent[rb] = ra
      this.stack.push([rb, ra, false])
    } else {
      this.parent[rb] = ra
      this.rank[ra]!++
      this.stack.push([rb, ra, true])
    }
    return true
  }
  rollback(mark: number): void {
    while (this.stack.length > mark) {
      const [c, p, bumped] = this.stack.pop()!
      this.parent[c] = c
      if (bumped) this.rank[p]!--
    }
  }
}

/** 格子 (cx,cy) 取 dir 时，对角线的两个端点（顶点索引） */
function endpoints(w: number, cx: number, cy: number, dir: CellState) {
  return dir === CS.Slash
    ? { a: cy * (w + 1) + cx + 1, b: (cy + 1) * (w + 1) + cx }
    : { a: cy * (w + 1) + cx, b: (cy + 1) * (w + 1) + cx + 1 }
}

/** 随机造一个完整且无环的填法 */
function randomSolution(w: number, h: number, rng: () => number): CellState[] | null {
  const total = w * h
  const cells = new Array<CellState>(total).fill(CS.Unknown)
  const dsu = new DSU((w + 1) * (h + 1))
  const order = shuffled(
    Array.from({ length: total }, (_, i) => i),
    rng,
  )

  const dfs = (k: number): boolean => {
    if (k === total) return true
    const idx = order[k]!
    const cx = idx % w
    const cy = Math.floor(idx / w)
    for (const dir of shuffled([CS.Backslash, CS.Slash] as CellState[], rng)) {
      const { a, b } = endpoints(w, cx, cy, dir)
      if (dsu.find(a) === dsu.find(b)) continue // 会成环
      const mark = dsu.stack.length
      dsu.union(a, b)
      cells[idx] = dir
      if (dfs(k + 1)) return true
      cells[idx] = CS.Unknown
      dsu.rollback(mark)
    }
    return false
  }

  return dfs(0) ? cells : null
}

/** 由完整填法算顶点数字 */
function cluesFromSolution(w: number, h: number, cells: CellState[]): VertexNumber[] {
  const clues = new Array<VertexNumber>((w + 1) * (h + 1)).fill(0)
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const dir = cells[cy * w + cx]!
      const { a, b } = endpoints(w, cx, cy, dir)
      clues[a] = ((clues[a] as number) + 1) as VertexNumber
      clues[b] = ((clues[b] as number) + 1) as VertexNumber
    }
  }
  return clues
}

/* ———————————————————— 出题 ———————————————————— */

interface Spec {
  id: string
  name: string
  width: number
  height: number
  difficulty: 'easy' | 'medium' | 'hard'
  series: string
  seed: number
  /** 目标线索密度（保留的顶点数字比例） */
  keepRatio: number
}

const SPECS: Spec[] = [
  { id: 'starter-4x4', name: '入门 · 4×4', width: 4, height: 4, difficulty: 'easy', series: 'starter', seed: 20260201, keepRatio: 0.95 },
  { id: 'starter-5x5-A', name: '入门 · 5×5 A', width: 5, height: 5, difficulty: 'easy', series: 'starter', seed: 20260202, keepRatio: 0.8 },
  { id: 'starter-5x5-B', name: '入门 · 5×5 B', width: 5, height: 5, difficulty: 'easy', series: 'starter', seed: 20260203, keepRatio: 0.75 },
  { id: 'classic-6x6-A', name: '经典 · 6×6 A', width: 6, height: 6, difficulty: 'medium', series: 'classic', seed: 20260204, keepRatio: 0.7 },
  { id: 'classic-6x6-B', name: '经典 · 6×6 B', width: 6, height: 6, difficulty: 'medium', series: 'classic', seed: 20260205, keepRatio: 0.65 },
  { id: 'classic-7x7-A', name: '经典 · 7×7 A', width: 7, height: 7, difficulty: 'medium', series: 'classic', seed: 20260206, keepRatio: 0.6 },
  { id: 'classic-8x8-A', name: '经典 · 8×8 A', width: 8, height: 8, difficulty: 'hard', series: 'classic', seed: 20260207, keepRatio: 0.55 },
  { id: 'challenge-9x9', name: '挑战 · 9×9', width: 9, height: 9, difficulty: 'hard', series: 'challenge', seed: 20260208, keepRatio: 0.5 },
]

function clueToString(c: VertexNumber): string {
  return c === null ? '.' : String(c)
}

function cellToString(c: CellState): string {
  return c === CS.Backslash ? '\\' : '/'
}

function generate(spec: Spec) {
  const { width: w, height: h } = spec
  const rng = mulberry32(spec.seed)
  const t0 = Date.now()

  const make = (clueArr: VertexNumber[]): Puzzle => ({
    id: spec.id,
    name: spec.name,
    width: w,
    height: h,
    clues: clueArr,
    difficulty: spec.difficulty,
  })

  // 1) 随机无环解 + 全数字题；全数字也可能多解（顶点数字不总能区分两种填法），
  //    此时换一个参考解重来。
  let solution: CellState[] | null = null
  let clues: VertexNumber[] = []
  for (let attempt = 0; attempt < 60; attempt++) {
    let cand: CellState[] | null = null
    for (let i = 0; i < 200 && !cand; i++) cand = randomSolution(w, h, rng)
    if (!cand) break
    const fullClues = cluesFromSolution(w, h, cand)
    const full = countSolutions(make(fullClues), 2, { maxNodes: 2_000_000, timeBudgetMs: 20_000 })
    if (full.count === 1) {
      solution = cand
      clues = fullClues
      break
    }
  }
  if (!solution) throw new Error(`${spec.id}: 找不到「全数字即唯一解」的参考解`)

  const fullClueCount = clues.filter((c) => c !== null).length

  // 随机删数字，保持唯一解
  const vCount = (w + 1) * (h + 1)
  const targetKeep = Math.max(4, Math.round(vCount * spec.keepRatio))
  const order = shuffled(
    Array.from({ length: vCount }, (_, i) => i),
    rng,
  )
  const budgetEnd = Date.now() + 90_000
  let kept = fullClueCount

  for (const v of order) {
    if (kept <= targetKeep) break
    if (Date.now() > budgetEnd) break
    const backup = clues[v]!
    clues[v] = null
    const r = countSolutions(make(clues), 2, { maxNodes: 400_000, timeBudgetMs: 4_000 })
    if (r.count !== 1 || r.timedOut) {
      clues[v] = backup // 删了就不唯一 → 回滚
    } else {
      kept--
    }
  }

  const finalCheck = countSolutions(make(clues), 2, { maxNodes: 4_000_000, timeBudgetMs: 60_000 })
  if (finalCheck.count !== 1) {
    throw new Error(`${spec.id}: 最终唯一解校验失败 count=${finalCheck.count} timedOut=${finalCheck.timedOut}`)
  }

  console.log(
    `${spec.id.padEnd(16)} ${w}x${h}  线索 ${kept}/${vCount} (${((kept / vCount) * 100).toFixed(0)}%)  解数=${finalCheck.count}  ${Date.now() - t0}ms`,
  )

  return {
    id: spec.id,
    name: spec.name,
    width: w,
    height: h,
    difficulty: spec.difficulty,
    series: spec.series,
    clues: clues.map(clueToString).join(''),
    solution: solution.map(cellToString).join(''),
  }
}

/* ———————————————————— 输出 ———————————————————— */

const rows = SPECS.map(generate)

const file = `/* 自动生成，勿手改。scripts/gen-puzzles.mts（npm run gen） */
export type RawPuzzle = {
  id: string
  name: string
  width: number
  height: number
  difficulty: 'easy'|'medium'|'hard'|'custom'
  series: string
  /** 顶点数字串：'.' = 无数字，'0'-'4'；length = (W+1)*(H+1)，row-major */
  clues: string
  /** 参考解：'\\\\' = 反斜杠，'/' = 斜杠；length = W*H，row-major */
  solution: string
}

export const RAW_PUZZLES: RawPuzzle[] = [
${rows
  .map(
    (r) =>
      `  { id: ${JSON.stringify(r.id)}, name: ${JSON.stringify(r.name)}, width: ${r.width}, height: ${r.height}, difficulty: ${JSON.stringify(r.difficulty)}, series: ${JSON.stringify(r.series)}, clues: ${JSON.stringify(r.clues)}, solution: ${JSON.stringify(r.solution)} },`,
  )
  .join('\n')}
]
`

writeFileSync(new URL('../src/puzzles-data.ts', import.meta.url), file, 'utf8')
console.log('\n已写入 src/puzzles-data.ts')
