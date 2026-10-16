/**
 * 逻辑解谜器测试：看规则 1 在每道题上能推出多少。
 * 用法：npm run logic-test
 */
import { puzzles } from '../src/puzzles.ts'
import { planLogicSolve } from '../src/logic.ts'
import { createEmptyState } from '../src/state.ts'
import { validate } from '../src/validate.ts'
import { CellState as CS } from '../src/types.ts'

let fail = 0

for (const p of puzzles) {
  const plan = planLogicSolve(p)
  const unknown = plan.cells.filter((c) => c === CS.Unknown).length

  // 推出来的部分必须自洽（不与参考解冲突、不引入非法状态）
  const st = createEmptyState(p)
  st.cells = plan.cells.slice()
  const v = validate(st, p)
  const wrong =
    p.solution &&
    plan.cells.some((c, i) => c !== CS.Unknown && c !== p.solution![i])
  const legal = v.badVertices.length === 0 && !v.hasLoop

  if (plan.conflicts.length || wrong || !legal) fail++
  const r1 = plan.steps.filter((s) => s.reason.startsWith('规则1')).length
  const r2 = plan.steps.filter((s) => s.reason.startsWith('规则2')).length
  console.log(
    `${p.id.padEnd(16)} ${p.width}x${p.height}  步数=${String(plan.steps.length).padStart(3)} (规则1=${r1} 规则2=${r2})  未定=${String(unknown).padStart(3)}  与参考解一致=${!wrong}  自洽=${legal}  ${plan.ms}ms${plan.conflicts.length ? '  冲突:' + plan.conflicts[0] : ''}`,
  )
  for (const s of plan.steps.filter((s) => s.reason.startsWith('规则2')).slice(0, 2)) {
    console.log(`      · ${s.reason}`)
  }
}

/* ——— 规则 2 定向测试：构造一条开口链，看第 4 格是否被强制 ——— */
{
  const w = 4
  const h = 4
  const clues = new Array<VertexNumber>((w + 1) * (h + 1)).fill(null)
  const cells = new Array<CellState>(w * h).fill(CS.Unknown)
  const put2 = (cx: number, cy: number, v: CellState) => {
    cells[cy * w + cx] = v
  }
  // 三条已填：(1,1)=\(1,2)=/(2,0)=\  → 连成 (1,1)-(2,2)-(3,1)-(2,0) 的开口链
  put2(1, 1, CS.Backslash)
  put2(2, 1, CS.Slash)
  put2(2, 0, CS.Backslash)

  const p: Puzzle = { id: 'r2-case', name: 'r2', width: w, height: h, clues, difficulty: 'custom' }
  const plan = planLogicSolve(p, cells)
  const step = plan.steps.find((s) => s.cell === 0 * w + 1) // 格子 (1,0)

  const good =
    !!step &&
    step.value === CS.Backslash &&
    step.reason.includes('规则2') &&
    plan.conflicts.length === 0
  if (!good) fail++
  console.log(
    `${good ? '✓' : '✗'} 规则2 定向：格子 (1,0) 被强制为 ${step ? (step.value === CS.Backslash ? '\\' : '/') : '（无结论）'}${step ? '  · ' + step.reason : ''}`,
  )
}

console.log('')
if (fail) {
  console.log(`${fail} 道题有问题`)
  process.exit(1)
}
console.log('规则 1 / 2 推得的结论全部自洽（无矛盾、不与参考解冲突）')
