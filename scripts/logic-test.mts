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
  const r3 = plan.steps.filter((s) => s.reason.startsWith('规则3')).length
  const r4 = plan.steps.filter((s) => s.reason.startsWith('规则4')).length
  console.log(
    `${p.id.padEnd(16)} ${p.width}x${p.height}  步数=${String(plan.steps.length).padStart(3)} (规则1=${r1} 规则2=${r2} 规则3=${r3} 规则4=${r4})  未定=${String(unknown).padStart(3)}  与参考解一致=${!wrong}  自洽=${legal}  ${plan.ms}ms${plan.conflicts.length ? '  冲突:' + plan.conflicts[0] : ''}`,
  )
  for (const s of plan.steps.filter((s) => s.reason.startsWith('规则3') || s.reason.startsWith('规则4')).slice(0, 2)) {
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
/* ——— 规则 3 定向：相邻的两个 1 → 四个非公共格背朝 ——— */
{
  const w = 4, h = 4
  const clues = new Array<VertexNumber>((w + 1) * (h + 1)).fill(null)
  clues[1 * (w + 1) + 1] = 1 // (1,1)
  clues[1 * (w + 1) + 2] = 1 // (2,1)  水平相邻，且 py=1 满足 1<=py<=h-1
  const p: Puzzle = { id: 'r3-case', name: 'r3', width: w, height: h, clues, difficulty: 'custom' }
  const plan = planLogicSolve(p)
  const got = new Map(plan.steps.map((s) => [s.cell, s.value]))
  // 期望：(0,0)=/  (0,1)=\   (2,0)=\   (2,1)=/
  const expect: Array<[number, number]> = [
    [0, CS.Slash],
    [w, CS.Backslash],
    [2, CS.Backslash],
    [w + 2, CS.Slash],
  ]
  const okAll = expect.every(([cell, v]) => got.get(cell) === v) && plan.conflicts.length === 0
  if (!okAll) fail++
  console.log(
    `${okAll ? '✓' : '✗'} 规则3 定向：相邻 1 的四个非公共格 = ${expect.map(([c, v]) => `(${c % w},${Math.floor(c / w)})=${v === CS.Backslash ? '\\' : '/'}`).join(' ')}`,
  )
}

/* ——— 规则 3/4 墙边：顶边相邻 1 只有 1 个公共格，两条款都不触发，推不出结论 ——— */
{
  const w = 4, h = 4
  const clues = new Array<VertexNumber>((w + 1) * (h + 1)).fill(null)
  clues[0 * (w + 1) + 1] = 1 // (1,0) 顶边
  clues[0 * (w + 1) + 2] = 1 // (2,0) 顶边，水平对但 py=0 → g=1, n=2, S=2，两条款均不触发
  const p: Puzzle = { id: 'r3-wall', name: 'r3w', width: w, height: h, clues, difficulty: 'custom' }
  const plan = planLogicSolve(p)
  const noConclusion = plan.steps.length === 0 && plan.conflicts.length === 0
  if (!noConclusion) fail++
  console.log(`${noConclusion ? '✓' : '✗'} 规则3/4 墙边：顶边相邻 1 不触发（g=1, n=2, S=2，额度推不出结论），步数=${plan.steps.length}`)
}

/* ——— 规则 4 墙边新能力：角上相邻两个 1 → 唯一非公共格必须相连 ——— */
{
  const w = 4, h = 4
  const clues = new Array<VertexNumber>((w + 1) * (h + 1)).fill(null)
  clues[0 * (w + 1) + 0] = 1 // (0,0) 角点，四周只有公共格 (0,0)
  clues[0 * (w + 1) + 1] = 1 // (1,0) 顶边，与角点水平相邻
  const p: Puzzle = { id: 'r4-corner', name: 'r4c', width: w, height: h, clues, difficulty: 'custom' }
  const plan = planLogicSolve(p)
  const got = new Map(plan.steps.map((s) => [s.cell, s.value]))
  // 角点 (0,0) 的额度被公共格占满 → Q=(1,0) 只能靠唯一非公共格 (1,0)，必须连朝 Q（Q 是它左上 → \）
  const cell10 = got.get(0 * w + 1)
  const good = cell10 === CS.Backslash && plan.conflicts.length === 0
  if (!good) fail++
  console.log(`${good ? '✓' : '✗'} 规则4 墙边：角上相邻 1 的非公共格 (1,0) 必须相连 = ${cell10 === CS.Backslash ? '\\' : cell10 === CS.Slash ? '/' : '（无结论）'}`)
}

/* ——— 规则 4 定向：相邻的两个 3 → 四个非公共格连朝 ——— */
{
  const w = 4, h = 4
  const clues = new Array<VertexNumber>((w + 1) * (h + 1)).fill(null)
  clues[1 * (w + 1) + 1] = 3 // (1,1)
  clues[2 * (w + 1) + 1] = 3 // (1,2)  垂直相邻，px=1 满足 1<=px<=w-1
  const p: Puzzle = { id: 'r4-case', name: 'r4', width: w, height: h, clues, difficulty: 'custom' }
  const plan = planLogicSolve(p)
  const got = new Map(plan.steps.map((s) => [s.cell, s.value]))
  // V=(1,1) 的非公共格 (0,0)[V 是右下→连朝需 \]、(1,0)[V 是左下→连朝需 /]
  // Q=(1,2) 的非公共格 (0,2)[Q 是右上→连朝需 /]、(1,2)[Q 是左上→连朝需 \]
  const expect: Array<[number, number]> = [
    [0, CS.Backslash],
    [1, CS.Slash],
    [2 * w + 0, CS.Slash],
    [2 * w + 1, CS.Backslash],
  ]
  const okAll = expect.every(([cell, v]) => got.get(cell) === v) && plan.conflicts.length === 0
  if (!okAll) fail++
  console.log(
    `${okAll ? '✓' : '✗'} 规则4 定向：相邻 3 的四个非公共格 = ${expect.map(([c, v]) => `(${c % w},${Math.floor(c / w)})=${v === CS.Backslash ? '\\' : '/'}`).join(' ')}`,
  )
}

console.log('')
if (fail) {  console.log(`${fail} 道题有问题`)
  process.exit(1)
}
console.log('规则 1/2/3/4 推得的结论全部自洽（无矛盾、不与参考解冲突）')
