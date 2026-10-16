/**
 * 验证「一条对角线上除了两端点外都是 2 ⟹ 两端点连通」是否成立。
 * 构造：4×4 盘面，主对角线上的 (1,1) 和 (2,2) 是 2，其余顶点无数字。
 * 手工指定一部分格子，然后穷举补全，看是否存在「无环且两端点不连通」的完整解。
 */
import { cellIndex, createEmptyState } from '../src/state.ts'
import { validate } from '../src/validate.ts'
import type { CellState, Puzzle } from '../src/types.ts'
import { CellState as CS } from '../src/types.ts'

const W = 4
const H = 4
const clues: Array<number | null> = new Array((W + 1) * (H + 1)).fill(null)
clues[1 * (W + 1) + 1] = 2 // (1,1)
clues[2 * (W + 1) + 2] = 2 // (2,2)

const puzzle: Puzzle = {
  id: 'c',
  name: 'c',
  width: W,
  height: H,
  clues,
  difficulty: 'custom',
}

// 手工指定：(0,0)=\  (1,0)=/  (1,1)=/  (1,2)=/  (2,2)=\
const fixed = new Map<number, CellState>([
  [cellIndex(W, 0, 0), CS.Backslash],
  [cellIndex(W, 1, 0), CS.Slash],
  [cellIndex(W, 1, 1), CS.Slash],
  [cellIndex(W, 1, 2), CS.Slash],
  [cellIndex(W, 2, 2), CS.Backslash],
])

// 端点 (0,0) 与 (3,3) 是否连通
function connected(cells: CellState[]): boolean {
  const total = (W + 1) * (H + 1)
  const parent = new Int32Array(total)
  for (let i = 0; i < total; i++) parent[i] = i
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]!
    return r
  }
  const ends = (cx: number, cy: number, dir: CellState) =>
    dir === CS.Slash
      ? [clueOf(cx + 1, cy), clueOf(cx, cy + 1)]
      : [clueOf(cx, cy), clueOf(cx + 1, cy + 1)]
  const clueOf = (px: number, py: number) => py * (W + 1) + px
  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      const v = cells[cellIndex(W, cx, cy)]!
      if (v === CS.Unknown) continue
      const [a, b] = ends(cx, cy, v)
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent[rb] = ra
    }
  }
  return find(clueOf(0, 0)) === find(clueOf(3, 3))
}

const free: number[] = []
for (let i = 0; i < W * H; i++) if (!fixed.has(i)) free.push(i)

let counterexamples = 0
let checked = 0
const dfs = (k: number, cells: CellState[]) => {
  if (counterexamples) return
  if (k === free.length) {
    const st = createEmptyState(puzzle)
    st.cells = cells.slice()
    const v = validate(st, puzzle)
    if (!v.solved) return
    checked++
    if (!connected(cells)) {
      counterexamples++
      console.log('找到反例（完整合法解，但两端点 (0,0) 与 (3,3) 不连通）：')
      for (let cy = 0; cy < H; cy++) {
        let line = ''
        for (let cx = 0; cx < W; cx++) {
          const v2 = cells[cellIndex(W, cx, cy)]!
          line += v2 === CS.Backslash ? '\\ ' : v2 === CS.Slash ? '/ ' : '? '
        }
        console.log('  ' + line)
      }
      console.log(`  已检查完整解 ${checked} 个`)
    }
    return
  }
  const i = free[k]!
  for (const v of [CS.Backslash, CS.Slash] as const) {
    cells[i] = v
    dfs(k + 1, cells)
    if (counterexamples) return
  }
  cells[i] = CS.Unknown
}

const cells = new Array<CellState>(W * H).fill(CS.Unknown)
for (const [i, v] of fixed) cells[i] = v
dfs(0, cells)

if (!counterexamples) {
  console.log(`未找到反例：检查了 ${checked} 个完整解，两端点始终连通`)
}
