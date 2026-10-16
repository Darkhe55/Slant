/**
 * 题库审计：校验 src/puzzles-data.ts 里每道题
 *   1. 串长度与题面尺寸吻合
 *   2. 参考解满足全部顶点数字
 *   3. 参考解无环
 *   4. 解唯一（countSolutions === 1）
 *
 * 用法：npm run check
 */
import { puzzles } from '../src/puzzles.ts'
import { countSolutions } from '../src/solver.ts'
import { createEmptyState } from '../src/state.ts'
import { validate } from '../src/validate.ts'

let fail = 0
const failIf = (cond: boolean, msg: string) => {
  if (cond) {
    console.log(`  ✗ ${msg}`)
    fail++
    return true
  }
  return false
}

console.log(`共 ${puzzles.length} 道题\n`)

for (const p of puzzles) {
  const w = p.width
  const h = p.height
  const vCount = (w + 1) * (h + 1)
  console.log(`${p.id}  ${w}×${h}  ${p.difficulty}`)

  let bad = false
  bad ||= failIf(p.clues.length !== vCount, `clues 长度 ${p.clues.length} ≠ ${vCount}`)
  bad ||= failIf(!p.solution || p.solution.length !== w * h, 'solution 长度不对')
  if (bad) continue

  const st = createEmptyState(p)
  st.cells = p.solution!.slice()
  const v = validate(st, p)
  bad ||= failIf(!v.solved, `参考解不合法：${JSON.stringify(v.badVertices)} loop=${v.hasLoop}`)

  const r = countSolutions(p, 2, { maxNodes: 4_000_000, timeBudgetMs: 60_000 })
  bad ||= failIf(r.timedOut, '唯一解校验超时')
  bad ||= failIf(r.count !== 1, `解数 = ${r.count}（应为 1）`)

  const clueNum = p.clues.filter((c) => c !== null).length
  console.log(`  ✓ 参考解合法 · 唯一解 · ${clueNum}/${vCount} 个数字 (${((clueNum / vCount) * 100).toFixed(0)}%)`)
}

console.log('')
if (fail) {
  console.log(`失败 ${fail} 项`)
  process.exit(1)
}
console.log('全部通过')
