import './styles.css'
import type { CellState, GameState, LogicStep, Move, Puzzle, VertexNumber } from './types'
import { CellState as CS } from './types'
import {
  applyMove,
  cellIndex,
  cellValue,
  createEmptyState,
  cycleCell,
  deserializeState,
  invertMove,
  serializeState,
} from './state'
import { clueCount, puzzles } from './puzzles'
import { loadSavedPuzzles, removeSavedPuzzle, savePuzzleToLibrary } from './library'
import { cellCenter, clientToViewBox, hitTestCell, metricsFor, renderBoard, updateColoring, updateFlash, updateHover } from './render'
import { validate } from './validate'
import { countSolutions } from './solver'
import { planLogicSolve } from './logic'
import { coloringDisplayMarks } from './coloring'
import { isMuted, resumeAudio, setMuted } from './audio'
import { FX_ANIM_MS, bumpStreak, fxNegative, fxPositive, resetStreak } from './fx'

const SAVE_PREFIX = 'xiexian-save:'

interface Session {
  puzzle: Puzzle
  state: GameState
  /** 每一组是一次「手势/操作」产生的改动，撤销时整组回退 */
  undo: Move[][]
  redo: Move[][]
  /** 提示填出来的格子（强调色） */
  hintCells: Set<number>
}

function $(sel: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(sel)
  if (!el) throw new Error(`missing ${sel}`)
  return el
}

function $input(sel: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(sel)
  if (!el) throw new Error(`missing ${sel}`)
  return el
}

/* ———————————————————— 存档 ———————————————————— */

function loadSave(puzzleId: string): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_PREFIX + puzzleId)
    if (!raw) return null
    const data = JSON.parse(raw) as {
      version: number
      puzzleId: string
      width: number
      height: number
      cells: number[]
    }
    if (data.version !== 1) return null
    return deserializeState(data)
  } catch {
    return null
  }
}

function saveState(session: Session): void {
  localStorage.setItem(
    SAVE_PREFIX + session.puzzle.id,
    JSON.stringify(serializeState(session.state)),
  )
}

function difficultyLabel(d: Puzzle['difficulty']): string {
  return d === 'easy' ? '入门' : d === 'medium' ? '进阶' : d === 'custom' ? '自定义' : '挑战'
}

/* ———————————————————— 页面骨架 ———————————————————— */

const app = document.querySelector('#app')
if (!app) throw new Error('no #app')

app.innerHTML = `
  <header class="topbar">
    <div class="brand">
      <h1>斜线</h1>
      <p>Gokigen Naname · 每格填入一条对角线，有两种选择，数字表示该点连接对角线数量，所有连线不能构成环路</p>
    </div>
    <div class="brand">
      <p style="margin:0">左右键将格子内容循环切换· 长按拖动可以连续填入</p>
    </div>
  </header>

  <div class="layout">
    <aside class="panel">
      <h2>题面</h2>
      <div class="toolbar" style="margin-top:0">
        <button class="btn" id="btn-random" type="button">随机抽题</button>
        <button class="btn" id="btn-mute" type="button">音效：开</button>
        <button class="btn" id="btn-custom" type="button">自定义</button>
      </div>
      <div class="puzzle-list" id="puzzle-list"></div>

      <div class="custom-editor" id="custom-editor" hidden>
        <h2>自定义题板</h2>
        <div class="custom-row">
          <label>宽 <input id="custom-w" type="number" min="2" max="60" value="5" /></label>
          <label>高 <input id="custom-h" type="number" min="2" max="60" value="5" /></label>
          <button class="btn" id="custom-regen" type="button">生成网格</button>
        </div>
        <div class="custom-hint">点击顶点循环：空 → 0 → 1 → 2 → 3 → 4 → 空 ｜ 键盘：方向键移动，0–4 填数，. / 退格清空，Enter / Tab 下一格</div>
        <div class="custom-grid" id="custom-grid"></div>
        <div class="toolbar" style="margin-top:10px">
          <button class="btn primary" id="custom-apply" type="button">载入题板</button>
          <button class="btn" id="custom-save" type="button">保存到题库</button>
          <button class="btn" id="custom-unique" type="button">唯一解校验</button>
          <button class="btn danger" id="custom-close" type="button">关闭</button>
        </div>
        <div class="custom-msg" id="custom-msg"></div>
      </div>

      <div class="toolbar">
        <button class="btn primary" id="btn-check" type="button">检查</button>
        <button class="btn" id="btn-undo" type="button">撤销</button>
        <button class="btn" id="btn-redo" type="button">重做</button>
        <button class="btn" id="btn-hint" type="button">提示一格</button>
        <button class="btn" id="btn-logic" type="button">逻辑解题</button>
        <button class="btn" id="btn-solve" type="button">显示解</button>
        <button class="btn danger" id="btn-clear" type="button">清空</button>
      </div>

      <div class="status" id="status">选择左侧题目开始。</div>

      <div class="logic-progress" id="logic-progress" hidden>
        <input type="range" id="logic-range" min="0" max="0" step="1" value="0" aria-label="逻辑回放进度" />
        <div class="logic-jump">
          <span>跳到</span>
          <input type="number" id="logic-step" min="0" max="0" step="1" value="0" aria-label="跳转步数" />
          <span>/ <b id="logic-total">0</b> 步</span>
          <button class="btn" id="logic-jump-btn" type="button">跳转</button>
          <button class="btn" id="logic-pause-btn" type="button">暂停</button>
        </div>
      </div>

      <div class="legend">
        <div><kbd>左键</kbd> 循环：空 → \ → / → 空</div>
        <div><kbd>右键</kbd> 反向循环 · <kbd>拖拽</kbd> 按住左键连续涂同一个方向</div>
        <div><kbd>滚轮</kbd> 缩放 · <kbd>中键拖拽</kbd> 平移 · <kbd>0</kbd> 复位视图</div>
        <div><kbd>Z</kbd> 撤销 · <kbd>Shift+Z</kbd> 重做</div>
        <div><kbd>C</kbd> 检查 · <kbd>H</kbd> 提示 · <kbd>S</kbd> 显示解 · <kbd>Esc</kbd> 清空</div>
        <div><kbd>R</kbd> 随机抽题 · <kbd>L</kbd> 逻辑解题 · <kbd>P</kbd> 暂停/继续 · <kbd>M</kbd> 音效开关</div>
      </div>
    </aside>

    <main class="panel board-wrap" id="board-wrap">
      <div class="zoom-bar">
        <button class="btn" id="zoom-out" type="button" title="缩小">−</button>
        <span class="zoom-label" id="zoom-label">100%</span>
        <button class="btn" id="zoom-in" type="button" title="放大">+</button>
        <button class="btn" id="zoom-reset" type="button">复位</button>
      </div>
      <div id="board"></div>
    </main>
  </div>
`

let session: Session | null = null
let pendingDeleteId: string | null = null

/* ———————————————————— 状态与刷新 ———————————————————— */

function setStatus(text: string, tone: 'ok' | 'bad' | 'solving' | '' = '') {
  const el = $('#status')
  el.textContent = text
  el.className = 'status' + (tone ? ` ${tone}` : '')
}

/** 内置题库 + 本地保存的自定义题 */
let library: Puzzle[] = [...puzzles]

function refreshLibrary(): void {
  library = [...loadSavedPuzzles(), ...puzzles]
}

/** 稳定排序：保存的自定义题在前，内置题保持原顺序 */
function sortedLibrary(): Puzzle[] {
  const rank = (p: Puzzle) => (p.difficulty === 'custom' ? 0 : 1)
  return [...library].sort((a, b) => rank(a) - rank(b))
}

function findPuzzle(id: string): Puzzle | undefined {
  return library.find((p) => p.id === id)
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function renderPuzzleList(): void {
  refreshLibrary()
  const list = $('#puzzle-list')
  list.innerHTML = sortedLibrary()
    .map((p) => {
      const active = session?.puzzle.id === p.id ? ' active' : ''
      const isCustom = p.difficulty === 'custom'
      const confirming = pendingDeleteId === p.id
      const actions = isCustom
        ? `<button class="puzzle-act" type="button" data-edit="${escapeHtml(p.id)}" title="编辑题面">编辑</button>` +
          `<button class="puzzle-act danger${confirming ? ' confirm' : ''}" type="button" data-del="${escapeHtml(p.id)}" title="${confirming ? '再点一次确认删除' : '从题库删除'}">${confirming ? '确认' : '×'}</button>`
        : ''
      return `
        <div class="puzzle-row">
          <button class="puzzle-item${active}" data-id="${escapeHtml(p.id)}" type="button">
            <span class="title">${escapeHtml(p.name)}</span>
            <span class="meta">${p.width}×${p.height} · ${difficultyLabel(p.difficulty)} · ${clueCount(p)} 个数字</span>
          </button>
          ${actions}
        </div>
      `
    })
  .join('')
  list.querySelectorAll<HTMLButtonElement>('.puzzle-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.id ? findPuzzle(btn.dataset.id) : undefined
      if (p) selectPuzzle(p)
    })
  })
  list.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.edit
      if (id) editPuzzle(id)
    })
  })
  list.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.del
      if (!id) return
      if (pendingDeleteId === id) deletePuzzle(id)
      else {
        pendingDeleteId = id
        renderPuzzleList()
      }
    })
  })
}


// 删除二次确认：点击其它位置自动取消，避免误触
document.addEventListener('click', (e) => {
  if (!pendingDeleteId) return
  const target = e.target as Element | null
  if (target?.closest('[data-del]')) return
  pendingDeleteId = null
  renderPuzzleList()
})


function editPuzzle(id: string): void {
  const puzzle = findPuzzle(id)
  if (!puzzle || puzzle.difficulty !== 'custom') return
  editCustomPuzzle(puzzle)
}

function deletePuzzle(id: string): void {
  const puzzle = findPuzzle(id)
  if (!puzzle || puzzle.difficulty !== 'custom') return
  pendingDeleteId = null
  const wasCurrent = session?.puzzle.id === id
  if (editingId === id) {
    editingId = null
    editingName = null
  }
  removeSavedPuzzle(id)
  localStorage.removeItem(SAVE_PREFIX + id)
  refreshLibrary()
  if (wasCurrent) {
    const next = sortedLibrary()[0]
    if (next) {
      selectPuzzle(next)
    } else {
      session = null
      $('#board').innerHTML = ''
      renderPuzzleList()
    }
  } else {
    renderPuzzleList()
  }
  setStatus(`已删除「${puzzle.name}」。`, 'ok')
}

function currentSvg(): SVGSVGElement | null {
  return $('#board').querySelector<SVGSVGElement>('svg.board-svg')
}

function renderBoardOnly() {
  if (!session) return
  const result = validate(session.state, session.puzzle)
  $('#board').innerHTML = renderBoard(session.puzzle, session.state, result, {
    hintCells: session.hintCells,
  })
  // innerHTML 重建会抹掉悬停/演示层，这里补回来
  const svg = currentSvg()
  if (svg) {
    const m = metricsFor(session.puzzle)
    if (hoverCell !== null) {
      updateHover(svg, m, hoverCell)
    }
    if (flashCell !== null) updateFlash(svg, m, flashCell)
    if (coloringMarks) updateColoring(svg, m, coloringMarks)
  }
}

function refresh() {
  renderPuzzleList()
  renderBoardOnly()
  if (!session) return
  const result = validate(session.state, session.puzzle)
  $('#board-wrap').classList.toggle('solved', result.solved)

  if (result.solved) {
    setStatus('完成！所有格子已填，数字全部吻合，且没有成环。', 'ok')
    return
  }
  const bits: string[] = [`已填 ${result.filled}/${session.puzzle.width * session.puzzle.height}`]
  if (result.badVertices.length) bits.push(`${result.badVertices.length} 个数字冲突`)
  if (result.hasLoop) bits.push('存在环路（已标红）')
  if (!result.badVertices.length && !result.hasLoop) {
    bits.push(`已满足 ${result.satisfiedVertices.length} 个数字`)
  }
  setStatus(bits.join(' · '))
}

/* ———————————————————— 落子 ———————————————————— */

function moveFor(index: number, to: CellState): Move | null {
  if (!session) return null
  const from = cellValue(session.state, index)
  if (from === to) return null
  return { index, from, to }
}

/** 应用一组改动，作为一个撤销单元 */
function pushMoves(moves: Array<Move | null>): number {
  if (!session) return 0
  const group = moves.filter((m): m is Move => m !== null)
  if (!group.length) return 0
  for (const mv of group) applyMove(session.state, mv)
  session.undo.push(group)
  session.redo.length = 0
  saveState(session)
  return group.length
}

function setCells(targets: Array<{ index: number; value: CellState }>): number {
  if (!session) return 0
  // 手动改盘面后旧回放基准失效，作废进度面板
  dropLogicReplay()
  const moves = targets.map((t) => moveFor(t.index, t.value))
  const n = pushMoves(moves)
  if (n) {
    for (const t of targets) session.hintCells.delete(t.index)
    refresh()
  }
  return n
}

function undo(): void {
  if (!session) return
  dropLogicReplay()
  const group = session.undo.pop()
  if (!group) return
  for (let i = group.length - 1; i >= 0; i--) applyMove(session.state, invertMove(group[i]!))
  session.redo.push(group)
  saveState(session)
  refresh()
}

function redo(): void {
  if (!session) return
  dropLogicReplay()
  const group = session.redo.pop()
  if (!group) return
  for (const mv of group) applyMove(session.state, mv)
  session.undo.push(group)
  saveState(session)
  refresh()
}

function clearBoard(): void {
  if (!session) return
  stopLogic()
  const total = session.puzzle.width * session.puzzle.height
  const targets = []
  for (let i = 0; i < total; i++) targets.push({ index: i, value: CS.Unknown })
  if (setCells(targets)) setStatus('已清空。')
}

function showSolution(): void {
  if (!session) return
  stopLogic()
  const sol = session.puzzle.solution
  if (!sol) {
    setStatus('这道题没有参考解（自定义题可用「唯一解校验」确认有解）。', 'bad')
    return
  }
  const targets = sol.map((value, index) => ({ index, value }))
  if (setCells(targets)) setStatus('已显示参考解（可撤销）。', 'solving')
}

function hint(): void {
  if (!session) return
  const sol = session.puzzle.solution
  if (!sol) {
    setStatus('这道题没有参考解，无法提示。', 'bad')
    return
  }
  const w = session.puzzle.width
  const h = session.puzzle.height
  const unknown: number[] = []
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const i = cellIndex(w, cx, cy)
      if (cellValue(session.state, i) === CS.Unknown) unknown.push(i)
    }
  }
  if (!unknown.length) {
    setStatus('已经没有空格了。')
    return
  }
  // 优先提示与「对不上的数字」相邻的格子
  const result = validate(session.state, session.puzzle)
  const near = new Set<number>()
  for (const v of result.badVertices) {
    for (let cy = Math.max(0, v.py - 1); cy <= Math.min(h - 1, v.py); cy++) {
      for (let cx = Math.max(0, v.px - 1); cx <= Math.min(w - 1, v.px); cx++) {
        const i = cellIndex(w, cx, cy)
        if (cellValue(session.state, i) === CS.Unknown) near.add(i)
      }
    }
  }
  const pool = near.size ? [...near] : unknown
  const pick = pool[Math.floor(Math.random() * pool.length)]!
  const n = setCells([{ index: pick, value: sol[pick]! }])
  if (n) {
    session.hintCells.add(pick)
    refresh()
    setStatus('已提示一格（橙色），可继续手动完成。', 'solving')
  }
}

/* ———————————————————— 逻辑解题（规则 1 演示播放） ———————————————————— */

let logicPlaying = false
let logicPaused = false
let logicToken = 0
let flashCell: number | null = null

/** 回放进度：已应用的帧数（0 起）/ 总帧数 */
let logicFrame = 0
let logicTotal = 0
/** 回放基准快照与计划帧，用于进度条跳转时从基准重放前 N 帧 */
let logicBase: GameState | null = null
let logicBaseHints = new Set<number>()
let logicFrames: LogicStep[] = []
let logicPuzzleId = ''

function sleepPausable(ms: number, token: number): Promise<boolean> {
  return new Promise((resolve) => {
    let left = ms
    const step = () => {
      if (token !== logicToken) return resolve(false)
      if (logicPaused) {
        setTimeout(step, 60)
        return
      }
      left -= 60
      if (left <= 0) return resolve(true)
      setTimeout(step, 60)
    }
    setTimeout(step, 60)
  })
}

/** 逻辑演示连拍加速的上限档位（与 fx.ts 的连拍上限一致） */
const LOGIC_STREAK_MAX = 12

/** 连拍数 → 演示间隔：基数 FX_ANIM_MS，每连一拍收敛一档，下限 50ms */
function logicGapMs(streak: number): number {
  return Math.max(50, Math.round(FX_ANIM_MS / Math.max(1, streak)))
}

function setLogicButton(playing: boolean): void {
  $('#btn-logic').textContent = playing ? '停止演示' : '逻辑解题'
}

/** 逻辑解题回放时的染色层标记（null = 不显示；规则5 步骤播放时铺出颜色类分组） */
let coloringMarks: Array<{ cx: number; cy: number; fill: string }> | null = null

function setColoringLayer(marks: Array<{ cx: number; cy: number; fill: string }> | null): void {
  coloringMarks = marks
  const svg = currentSvg()
  if (svg && session) updateColoring(svg, metricsFor(session.puzzle), marks)
}

/* ———————————————————— 回放进度条 / 暂停 / 跳转 ———————————————————— */

/** 同步滑块、数字框与总帧数 */
function updateLogicProgress(): void {
  const slider = document.querySelector<HTMLInputElement>('#logic-range')
  const step = document.querySelector<HTMLInputElement>('#logic-step')
  const total = document.querySelector<HTMLElement>('#logic-total')
  if (slider) {
    slider.max = String(logicTotal)
    slider.value = String(Math.max(0, Math.min(logicTotal, logicFrame)))
  }
  if (step) {
    step.max = String(logicTotal)
    step.value = String(Math.max(0, Math.min(logicTotal, logicFrame)))
  }
  if (total) total.textContent = String(logicTotal)
}

function showLogicProgress(): void {
  const panel = document.querySelector<HTMLElement>('#logic-progress')
  if (panel) panel.hidden = false
  updateLogicProgress()
}

function hideLogicProgress(): void {
  const panel = document.querySelector<HTMLElement>('#logic-progress')
  if (panel) panel.hidden = true
}

/** 暂停/继续按钮：回放结束显示「重播」，暂停中显示「继续」 */
function updateLogicPauseButton(): void {
  const btn = document.querySelector<HTMLButtonElement>('#logic-pause-btn')
  if (!btn) return
  if (!logicFrames.length || !logicBase) {
    btn.disabled = true
    btn.textContent = '暂停'
    return
  }
  btn.disabled = false
  if (logicPlaying) btn.textContent = logicPaused ? '继续' : '暂停'
  else if (logicFrame >= logicTotal) btn.textContent = '重播'
  else btn.textContent = '继续'
}

/**
 * 作废当前回放计划并隐藏进度面板。
 * 手动改盘面 / 开始新一次推理前调用，避免「重播」用旧基准覆盖新进度。
 */
function dropLogicReplay(): void {
  logicToken++
  logicPlaying = false
  logicPaused = false
  logicFrames = []
  logicBase = null
  logicBaseHints = new Set<number>()
  logicFrame = 0
  logicTotal = 0
  logicPuzzleId = ''
  flashCell = null
  coloringMarks = null
  hideLogicProgress()
  updateLogicPauseButton()
  // 回放中途被手动操作打断时，按钮/屏蔽状态也要恢复
  setButtonsDisabled(false)
  setLogicButton(false)
}

function stopLogic(): void {
  dropLogicReplay()
  const svg = currentSvg()
  if (svg && session) {
    updateFlash(svg, metricsFor(session.puzzle), null)
    updateColoring(svg, metricsFor(session.puzzle), null)
  }
}

/**
 * 从回放基准快照重放前 n 帧，用于进度条拖动 / 跳转：
 * 同步撤销栈（清空）、存档与重绘；染色层按目标帧是否规则 7 重算。
 */
function rebuildLogicState(n: number): void {
  if (!session || !logicBase || !logicFrames.length) return
  if (session.puzzle.id !== logicPuzzleId) return
  const count = Math.max(0, Math.min(logicFrames.length, Math.floor(n)))
  session.state = {
    puzzleId: logicBase.puzzleId,
    width: logicBase.width,
    height: logicBase.height,
    cells: logicBase.cells.slice(),
  }
  session.undo = []
  session.redo = []
  session.hintCells = new Set(logicBaseHints)
  for (let k = 0; k < count; k++) {
    const step = logicFrames[k]!
    applyMove(session.state, {
      index: step.cell,
      from: cellValue(session.state, step.cell),
      to: step.value,
    })
  }
  logicFrame = count
  flashCell = null
  const last = count > 0 ? logicFrames[count - 1]! : null
  coloringMarks =
    last && last.reason.startsWith('规则7')
      ? coloringDisplayMarks(
          session.puzzle.width,
          session.puzzle.height,
          session.puzzle.clues,
          session.state.cells,
        )
      : null
  saveState(session)
  renderBoardOnly()
  updateLogicProgress()
}

/** 进度条 / 数字框跳转：立即重建到目标帧；回放中随后从该帧继续播放。 */
function seekLogicFrame(n: number): void {
  if (!logicFrames.length || !logicBase) return
  if (!session || session.puzzle.id !== logicPuzzleId) return
  const target = Math.max(0, Math.min(logicFrames.length, Math.floor(n)))
  rebuildLogicState(target)
  const slider = document.querySelector<HTMLInputElement>('#logic-range')
  const step = document.querySelector<HTMLInputElement>('#logic-step')
  if (slider) slider.value = String(target)
  if (step) step.value = String(target)
  updateLogicPauseButton()
  // 跳转后状态栏显示目标帧自身的回放理由；停在 0 时只显示起点。
  if (target > 0) {
    setStatus(`回放 [${target}/${logicTotal}] ${logicFrames[target - 1]!.reason}`, 'solving')
  } else {
    setStatus(`回放起点 [0/${logicTotal}]`, 'solving')
  }
}

function bindLogicProgress(): void {
  const slider = document.querySelector<HTMLInputElement>('#logic-range')
  const step = document.querySelector<HTMLInputElement>('#logic-step')
  const jump = document.querySelector<HTMLButtonElement>('#logic-jump-btn')
  if (!slider || !step || !jump) return
  slider.addEventListener('input', () => seekLogicFrame(Number(slider.value)))
  step.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      seekLogicFrame(Number(step.value))
    }
  })
  jump.addEventListener('click', () => seekLogicFrame(Number(step.value)))
  document
    .querySelector<HTMLButtonElement>('#logic-pause-btn')
    ?.addEventListener('click', toggleLogicPause)
}

/* ———————————————————— 回放播放 / 暂停 / 结束 ———————————————————— */

function finishLogicPlayback(token: number): void {
  if (token !== logicToken) return
  logicPlaying = false
  logicPaused = false
  setButtonsDisabled(false)
  setLogicButton(false)
  updateLogicPauseButton()
  updateLogicProgress()
  if (!session || session.puzzle.id !== logicPuzzleId) return
  flashCell = null
  coloringMarks = null
  renderBoardOnly()
  const result = validate(session.state, session.puzzle)
  if (result.solved) {
    setStatus(`逻辑解题完成：${logicTotal} 步推出全部格子，并通过校验。`, 'ok')
  } else {
    setStatus(
      `逻辑解题：已采用 ${logicTotal} 步，还剩 ${result.unknown} 格推不出（当前规则到此为止）。`,
      'solving',
    )
  }
}

/**
 * 暂停/继续回放（快捷键 P）；回放结束后按钮变「重播」，从头重播。
 * 暂停时不写状态栏，保留当前帧的回放理由。
 */
function toggleLogicPause(): void {
  if (!logicPlaying) {
    if (!logicFrames.length || !logicBase) return
    if (!session || session.puzzle.id !== logicPuzzleId) return
    const replaying = logicFrame >= logicTotal
    if (replaying) rebuildLogicState(0)
    logicPlaying = true
    logicPaused = false
    const token = ++logicToken
    setButtonsDisabled(true)
    setLogicButton(true)
    updateLogicPauseButton()
    if (replaying) setStatus(`重播逻辑回放 [0/${logicTotal}]…`, 'solving')
    void playLogicPlan(logicPuzzleId, token).then(() => finishLogicPlayback(token))
    return
  }
  logicPaused = !logicPaused
  updateLogicPauseButton()
}

/** 相位 2：只回放已算好的计划，支持暂停与任意帧跳转 */
async function playLogicPlan(puzzleId: string, token: number): Promise<void> {
  while (token === logicToken) {
    if (!session || session.puzzle.id !== puzzleId) return
    if (logicFrame >= logicTotal) {
      // 等最后一帧的落子特效演完再收尾；期间若被跳转则继续回放
      if (!(await sleepPausable(FX_ANIM_MS, token))) return
      if (logicFrame < logicTotal) continue
      return
    }
    const index = logicFrame
    const step = logicFrames[index]!
    // 染色枚举步：先把当前未定格的染色分组铺到格底（落子后按新局面重算）
    const isColoring = step.reason.startsWith('规则7')
    {
      const s = session
      setColoringLayer(
        isColoring
          ? coloringDisplayMarks(s.puzzle.width, s.puzzle.height, s.puzzle.clues, s.state.cells)
          : null,
      )
    }
    // 高亮正在推理的格子 + 状态栏说明理由
    flashCell = step.cell
    const svg = currentSvg()
    if (svg) updateFlash(svg, metricsFor(session.puzzle), flashCell)
    setStatus(`[${index + 1}/${logicTotal}] ${step.reason}`, 'solving')
    // 连拍加速：每推一步升一档，与填的是 \ 还是 / 无关，不重置
    const streak = Math.min(index + 1, LOGIC_STREAK_MAX)
    // 等一段特效时长让弦振/光晕演完；暂停期间计时停住
    if (!(await sleepPausable(logicGapMs(streak), token))) return
    if (!session || session.puzzle.id !== puzzleId) return
    // 等待期间被拖动/跳转 → 已重建到目标帧，从新位置继续，不重复应用这一帧
    if (logicFrame !== index) continue
    flashCell = null
    const move = moveFor(step.cell, step.value)
    if (move) pushMoves([move])
    session.hintCells.delete(step.cell)
    logicFrame++
    renderBoardOnly()
    updateLogicProgress()
    // 落子后按新局面重算染色分组（随播放进度更新）
    if (isColoring && session) {
      setColoringLayer(
        coloringDisplayMarks(
          session.puzzle.width,
          session.puzzle.height,
          session.puzzle.clues,
          session.state.cells,
        ),
      )
    }
    // 落子特效：弦振抖动 + 光晕 + 拨弦音（连拍抬音高）
    playCellFx(step.cell, true)
  }
}

async function runLogicSolver(): Promise<void> {
  if (!session) return
  if (logicPlaying) {
    stopLogic()
    setStatus('已停止逻辑解题演示。')
    return
  }

  // 上一次回放的计划已过期（盘面可能已改动），先作废，避免「重播」覆盖新进度
  dropLogicReplay()

  // 从玩家当前进度开始推理
  const plan = planLogicSolve(session.puzzle, session.state)
  if (plan.conflicts.length) {
    setStatus(`逻辑解题中止：${plan.conflicts[0]}`, 'bad')
    return
  }
  if (!plan.steps.length) {
    const left = plan.cells.filter((c) => c === CS.Unknown).length
    setStatus(
      left
        ? `逻辑解题：现有规则推不出新结论，还剩 ${left} 格未定。`
        : '逻辑解题：盘面已填满，没有可推的格子。',
      'solving',
    )
    return
  }

  // 回放基准快照：跳转时从这里重放前 N 帧
  logicBase = {
    puzzleId: session.state.puzzleId,
    width: session.state.width,
    height: session.state.height,
    cells: session.state.cells.slice(),
  }
  logicBaseHints = new Set(session.hintCells)
  logicFrames = plan.steps
  logicPuzzleId = session.puzzle.id
  logicTotal = plan.steps.length
  logicFrame = 0
  logicPaused = false
  logicPlaying = true
  setLogicButton(true)
  setButtonsDisabled(true)
  resetStreak()
  showLogicProgress()
  updateLogicPauseButton()
  const token = ++logicToken
  setStatus(
    `逻辑解题：${plan.steps.length} 步推导，开始演示（可暂停/拖动进度，再按一次停止）…`,
    'solving',
  )
  // 让「推理完成」先上屏，再开始回放（这段等待也可暂停）
  if (!(await sleepPausable(280, token))) return
  if (token !== logicToken) return
  try {
    await playLogicPlan(logicPuzzleId, token)
  } catch {
    /* ignore */
  }
  finishLogicPlayback(token)
}

function check(): void {
  if (!session) return
  const result = validate(session.state, session.puzzle)
  if (result.solved) {
    setStatus('检查通过：已解出。', 'ok')
    return
  }
  const bits: string[] = ['检查结果：']
  if (result.unknown) bits.push(`还有 ${result.unknown} 格未填`)
  if (result.badVertices.length) bits.push(`${result.badVertices.length} 个数字冲突（顶点已标红）`)
  if (result.hasLoop) bits.push('存在环路（红线部分）')
  if (!result.badVertices.length && !result.hasLoop && !result.unknown) bits.push('规则已满足')
  setStatus(bits.join(' · '), result.badVertices.length || result.hasLoop ? 'bad' : '')
}

/* ———————————————————— 选题 ———————————————————— */

function selectPuzzle(puzzle: Puzzle): void {
  stopLogic()
  const saved = loadSave(puzzle.id)
  session = {
    puzzle,
    state: saved ?? createEmptyState(puzzle),
    undo: [],
    redo: [],
    hintCells: new Set<number>(),
  }
  refresh()
  resetView()
  setStatus(`已载入「${puzzle.name}」。左键在格子里画对角线。`)
}

function pickRandomPuzzle(): void {
  const avoidId = session?.puzzle.id
  const pool = avoidId ? library.filter((p) => p.id !== avoidId) : library
  const list = pool.length ? pool : library
  selectPuzzle(list[Math.floor(Math.random() * list.length)]!)
}

/* ———————————————————— 悬停预览 ———————————————————— */

let hoverCell: number | null = null

function clearHover(): void {
  hoverCell = null
  const svg = currentSvg()
  if (svg && session) updateHover(svg, metricsFor(session.puzzle), null)
}

function updateHoverAt(clientX: number, clientY: number): void {
  if (!session) return
  const svg = currentSvg()
  if (!svg) return
  const vb = clientToViewBox(svg, clientX, clientY)
  if (!vb) return
  const m = metricsFor(session.puzzle)
  const cell = hitTestCell(m, session.puzzle, vb.x, vb.y)
  if (cell === hoverCell) return
  hoverCell = cell
  updateHover(svg, m, cell)
}

/* ———————————————————— 手势：点击 / 拖拽涂写 ———————————————————— */

interface Gesture {
  mode: 'paint' | 'pan'
  paintDir: CellState
  lastCell: number
  moves: Move[]
  startX: number
  startY: number
  moved: boolean
  pointerId: number
}

let gesture: Gesture | null = null

/** 按下即开始涂写手势：dir=1 正向循环（左键），-1 反向（右键）；拖动经过的格子沿用同一方向 */
function startPaint(e: PointerEvent, cell: number, dir: 1 | -1): void {
  if (!session) return
  dropLogicReplay()
  const cur = cellValue(session.state, cell)
  const paintDir = cycleCell(cur, dir)
  gesture = {
    mode: 'paint',
    paintDir,
    lastCell: cell,
    moves: [],
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    pointerId: e.pointerId,
  }
  const mv = moveFor(cell, paintDir)
  if (mv) {
    gesture.moves.push(mv)
    pushMoves([mv])
    session.hintCells.delete(cell)
    refresh()
    // 落子特效：弦振抖动 + 光晕 + 拨弦音
    playCellFx(cell, paintDir !== CS.Unknown, true)
  }
  hoverCell = cell
}

function boardPointerDown(e: PointerEvent): void {
  resumeAudio()
  if (!session) return
  const svg = currentSvg()
  if (!svg) return
  const m = metricsFor(session.puzzle)

  // 中键 → 平移
  if (e.button === 1) {
    e.preventDefault()
    gesture = {
      mode: 'pan',
      paintDir: CS.Unknown,
      lastCell: -1,
      moves: [],
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      pointerId: e.pointerId,
    }
    return
  }

  // 左键 = 正向循环，右键 = 反向循环；两者都支持长按拖动连续填入
  if (e.button === 0 || e.button === 2) {
    const vb = clientToViewBox(svg, e.clientX, e.clientY)
    if (!vb) return
    const cell = hitTestCell(m, session.puzzle, vb.x, vb.y)
    if (cell === null) {
      // 点在盘面外：左键也当平移用，方便看大图；右键无操作
      if (e.button === 0) {
        gesture = {
          mode: 'pan',
          paintDir: CS.Unknown,
          lastCell: -1,
          moves: [],
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
          pointerId: e.pointerId,
        }
      }
      return
    }
    startPaint(e, cell, e.button === 2 ? -1 : 1)
    return
  }
}

function boardPointerMove(e: PointerEvent): void {
  if (!gesture) {
    updateHoverAt(e.clientX, e.clientY)
    return
  }
  if (e.pointerId !== gesture.pointerId) return

  if (gesture.mode === 'pan') {
    const dx = e.clientX - gesture.startX
    const dy = e.clientY - gesture.startY
    if (!gesture.moved && Math.hypot(dx, dy) < 5) return
    gesture.moved = true
    panBy(dx, dy)
    gesture.startX = e.clientX
    gesture.startY = e.clientY
    return
  }

  // 涂写模式
  if (Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) > 8) {
    gesture.moved = true
  }
  const svg = currentSvg()
  if (!svg) return
  const vb = clientToViewBox(svg, e.clientX, e.clientY)
  if (!vb) return
  const m = metricsFor(session!.puzzle)
  const cell = hitTestCell(m, session!.puzzle, vb.x, vb.y)
  if (cell === null || cell === gesture.lastCell) return
  gesture.lastCell = cell
  const mv = moveFor(cell, gesture.paintDir)
  if (mv) {
    gesture.moves.push(mv)
    pushMoves([mv])
    session!.hintCells.delete(cell)
    refresh()
  }
}

function boardPointerUp(e: PointerEvent): void {
  if (!gesture || e.pointerId !== gesture.pointerId) return
  gesture = null
}

function bindBoard(): void {
  const board = $('#board')
  board.addEventListener('contextmenu', (e) => e.preventDefault())
  board.addEventListener('pointerdown', boardPointerDown)
  board.addEventListener('pointerleave', () => {
    if (!gesture) clearHover()
  })
  // 滚轮挂在容器上：#board 不重建，SVG 会因刷新而重建
  board.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
        e.stopPropagation()
      const svg = currentSvg()
      if (!svg || !session) return
      const vb = clientToViewBox(svg, e.clientX, e.clientY)
      setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), vb ?? undefined)
    },
    { passive: false },
  )
  // 移动/抬起挂在 window 上：拖拽时指针可能移出盘面，且刷新不影响监听
  window.addEventListener('pointermove', boardPointerMove)
  window.addEventListener('pointerup', boardPointerUp)
  window.addEventListener('pointercancel', boardPointerUp)
}

/* ———————————————————— 缩放 / 平移 ———————————————————— */

let zoom = 1
let panX = 0
let panY = 0

function resetView(): void {
  zoom = 1
  panX = 0
  panY = 0
  applyViewBox()
  updateZoomLabel()
}

function baseVB() {
  if (!session) return { w: 100, h: 100 }
  const m = metricsFor(session.puzzle)
  return { w: m.svgWidth, h: m.svgHeight }
}

function applyViewBox(): void {
  const svg = currentSvg()
  if (!svg) return
  const { w, h } = baseVB()
  svg.setAttribute('viewBox', `${panX} ${panY} ${w / zoom} ${h / zoom}`)
}

function clampPan(): void {
  const { w, h } = baseVB()
  const vw = w / zoom
  const vh = h / zoom
  panX = Math.min(Math.max(panX, Math.min(0, w - vw)), Math.max(0, w - vw))
  panY = Math.min(Math.max(panY, Math.min(0, h - vh)), Math.max(0, h - vh))
}

function setZoom(next: number, anchor?: { x: number; y: number }): void {
  if (!session) return
  const prev = zoom
  zoom = Math.min(Math.max(next, 0.5), 3)
  if (zoom === prev) return
  if (anchor) {
    // 保持锚点在屏幕上的位置不变
    panX = anchor.x - (anchor.x - panX) * (prev / zoom)
    panY = anchor.y - (anchor.y - panY) * (prev / zoom)
  }
  clampPan()
  applyViewBox()
  updateZoomLabel()
}

function panBy(dxScreen: number, dyScreen: number): void {
  const svg = currentSvg()
  if (!svg) return
  const rect = svg.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  const { w, h } = baseVB()
  const vw = w / zoom
  const vh = h / zoom
  panX -= (dxScreen / rect.width) * vw
  panY -= (dyScreen / rect.height) * vh
  clampPan()
  applyViewBox()
}

function updateZoomLabel(): void {
  $('#zoom-label').textContent = `${Math.round(zoom * 100)}%`
}

/* ———————————————————— 自定义题板 ———————————————————— */

let customW = 5
let customH = 5
let customClues: VertexNumber[] = new Array<VertexNumber>(36).fill(null)
/** 键盘光标所在顶点（0..W, 0..H） */
let customCursorX = 0
let customCursorY = 0
/** 正在编辑的题库条目 id / 名称（null = 新建） */
let editingId: string | null = null
let editingName: string | null = null

function customMsg(text: string, tone: 'ok' | 'bad' | '' = ''): void {
  const el = $('#custom-msg')
  el.textContent = text
  el.className = 'custom-msg' + (tone ? ` ${tone}` : '')
}

function customCellIndex(px: number, py: number): number {
  return py * (customW + 1) + px
}

function customEditorOpen(): boolean {
  return !$('#custom-editor').hidden
}

/** 直接改某个顶点的数字，只更新对应按钮，不重绘（保住焦点） */
function setCustomClue(px: number, py: number, value: VertexNumber): void {
  const i = customCellIndex(px, py)
  customClues[i] = value
  const btn = document.querySelector<HTMLButtonElement>(
    `.custom-cell[data-px="${px}"][data-py="${py}"]`,
  )
  if (btn) {
    btn.textContent = value === null ? '' : String(value)
    btn.classList.toggle('empty', value === null)
  }
}

/** 移动键盘光标到指定顶点（自动夹在网格范围内） */
function selectCustomVertex(px: number, py: number): void {
  customCursorX = Math.max(0, Math.min(customW, px))
  customCursorY = Math.max(0, Math.min(customH, py))
  document.querySelectorAll<HTMLElement>('.custom-cell').forEach((el) => {
    el.classList.toggle(
      'selected',
      Number(el.dataset.px) === customCursorX && Number(el.dataset.py) === customCursorY,
    )
  })
  const btn = document.querySelector<HTMLButtonElement>(
    `.custom-cell[data-px="${customCursorX}"][data-py="${customCursorY}"]`,
  )
  btn?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

/** 按线性序号选顶点（夹在棋盘范围内）；配合 moveCustomCursor 实现行末自动换行 */
function selectCustomVertexIndex(i: number): void {
  const cols = customW + 1
  const max = cols * (customH + 1)
  if (max <= 0) return
  const idx = Math.max(0, Math.min(max - 1, i))
  selectCustomVertex(idx % cols, Math.floor(idx / cols))
}

/**
 * 键盘光标相对移动（仿数回）：水平越界自动换行——
 * 越过右边界折到下一行行首，越过左边界折到上一行行尾，仅在棋盘首尾格夹停；
 * 垂直移动保持同一列、不换行。
 */
function moveCustomCursor(dx: number, dy: number): void {
  const cols = customW + 1
  const idx = customCursorY * cols + customCursorX
  const row = Math.floor(idx / cols)
  const col = idx % cols
  selectCustomVertexIndex((row + dy) * cols + (col + dx))
}

function renderCustomGrid(): void {
  const grid = $('#custom-grid')
  grid.style.gridTemplateColumns = `repeat(${customW + 1}, 34px)`
  const parts: string[] = []
  for (let py = 0; py <= customH; py++) {
    for (let px = 0; px <= customW; px++) {
      const v = customClues[customCellIndex(px, py)]
      const label = v === null || v === undefined ? '' : String(v)
      const sel = px === customCursorX && py === customCursorY ? ' selected' : ''
      parts.push(
        `<button class="custom-cell${v === null ? ' empty' : ''}${sel}" type="button" data-px="${px}" data-py="${py}">${label}</button>`,
      )
    }
  }
  grid.innerHTML = parts.join('')
  grid.tabIndex = 0
  grid.querySelectorAll<HTMLButtonElement>('.custom-cell').forEach((btn) => {
    btn.addEventListener('click', () => {
      const px = Number(btn.dataset.px)
      const py = Number(btn.dataset.py)
      selectCustomVertex(px, py)
      const i = customCellIndex(px, py)
      const cur = customClues[i] ?? null
      customClues[i] = cur === null ? 0 : cur === 4 ? null : ((cur + 1) as VertexNumber)
      renderCustomGrid()
      grid.focus({ preventScroll: true })
    })
  })
}

function readCustomSize(): void {
  customW = Math.min(Math.max(Number($input('#custom-w').value) || 5, 2), 60)
  customH = Math.min(Math.max(Number($input('#custom-h').value) || 5, 2), 60)
}

function regenCustomGrid(): void {
  readCustomSize()
  customClues = new Array<VertexNumber>((customW + 1) * (customH + 1)).fill(null)
  customCursorX = 0
  customCursorY = 0
  editingId = null
  editingName = null
  renderCustomGrid()
  customMsg(`已生成 ${customW}×${customH} 网格，共 ${(customW + 1) * (customH + 1)} 个顶点。`)
  $('#custom-grid').focus({ preventScroll: true })
}

function openCustomEditor(): void {
  $('#custom-editor').hidden = false
  readCustomSize()
  const size = (customW + 1) * (customH + 1)
  if (customClues.length !== size) {
    customClues = new Array<VertexNumber>(size).fill(null)
    customCursorX = 0
    customCursorY = 0
  }
  $input('#custom-w').value = String(customW)
  $input('#custom-h').value = String(customH)
  renderCustomGrid()
  const editing = editingId ? `正在编辑「${editingName ?? editingId}」。` : ''
  customMsg(`${editing}键盘：方向键移动 · 0–4 填数 · . / 退格清空 · Enter 下一格 · Esc 关闭`)
  // 焦点进网格，便于直接打字
  $('#custom-grid').focus({ preventScroll: true })
}

/** 把已保存的自定义题读回编辑器（保存会覆盖原题） */
function editCustomPuzzle(puzzle: Puzzle): void {
  const clues = (puzzle as Puzzle & { clues?: VertexNumber[] }).clues
  const size = (puzzle.width + 1) * (puzzle.height + 1)
  if (!Array.isArray(clues) || clues.length !== size) return
  if (puzzle.width > 60 || puzzle.height > 60) {
    setStatus(`题面超过最大尺寸 60×60。`, 'bad')
    return
  }
  customW = puzzle.width
  customH = puzzle.height
  customClues = clues.slice()
  customCursorX = 0
  customCursorY = 0
  editingId = puzzle.id
  editingName = puzzle.name
  $input('#custom-w').value = String(customW)
  $input('#custom-h').value = String(customH)
  $('#custom-editor').hidden = false
  renderCustomGrid()
  customMsg(`正在编辑「${puzzle.name}」。保存会覆盖原题。`, 'ok')
  $('#custom-editor').scrollIntoView({ block: 'nearest' })
  $('#custom-grid').focus({ preventScroll: true })
}

function closeCustomEditor(): void {
  $('#custom-editor').hidden = true
  customMsg('')
}

function loadCustomPuzzle(): void {
  readCustomSize()
  const size = (customW + 1) * (customH + 1)
  if (customClues.length !== size) {
    customClues = new Array<VertexNumber>(size).fill(null)
    renderCustomGrid()
    customMsg('网格已重置，请填数字。', 'bad')
    return
  }
  // 载入即入库：用「宽x高」做稳定 id，重复载入同尺寸只覆盖同一条，
  // 否则刷新/切走后再也找不到这块题板（进度是按题 id 存的，id 稳定才能接上）。
  // 编辑已有题目时沿用原 id，载入即覆盖原题。
  const stableId = editingId ?? `custom-${customW}x${customH}`
  const puzzle: Puzzle = {
    id: stableId,
    name: editingName ?? `自定义 · ${customW}×${customH}`,
    width: customW,
    height: customH,
    clues: customClues.slice(),
    difficulty: 'custom',
  }
  const saved = savePuzzleToLibrary(puzzle)
  const kept = saved.find((x) => x.id === stableId) ?? puzzle
  editingId = kept.id
  editingName = kept.name
  refreshLibrary()
  // 注意：不自动关闭编辑器——题板保持展开，除非手动点「关闭」（或按 Esc）
  selectPuzzle(kept)
  customMsg('题板已载入并存入题库，可点「唯一解校验」或「逻辑解题」。', 'ok')
  setStatus(`已载入自定义 ${customW}×${customH}，并存入题库（刷新后仍在列表里）。`)
}

/** 把当前题板存进题库（不关闭编辑器，可继续改或再存） */
function saveCustomPuzzle(): void {
  readCustomSize()
  if (customClues.length !== (customW + 1) * (customH + 1)) {
    customMsg('请先生成网格并填好数字。', 'bad')
    return
  }
  const isEditing = !!editingId
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`
  const puzzle: Puzzle = {
    id: editingId ?? `custom-${customW}x${customH}-${Date.now().toString(36)}`,
    name: editingName ?? `自定义 · ${customW}×${customH} · ${stamp}`,
    width: customW,
    height: customH,
    clues: customClues.slice(),
    difficulty: 'custom',
  }
  savePuzzleToLibrary(puzzle)
  editingId = puzzle.id
  editingName = puzzle.name
  refreshLibrary()
  renderPuzzleList()
  customMsg(`已${isEditing ? '更新' : '保存'}到题库：「${puzzle.name}」，下次启动仍可选用。`, 'ok')
  setStatus(`自定义题已存入题库「${puzzle.name}」。`)
}

function checkCustomUnique(): void {
  readCustomSize()
  const puzzle: Puzzle = {
    id: 'custom-check',
    name: 'custom-check',
    width: customW,
    height: customH,
    clues: customClues.slice(),
    difficulty: 'custom',
  }
  const t0 = Date.now()
  const r = countSolutions(puzzle, 2, { maxNodes: 400_000, timeBudgetMs: 8_000 })
  if (r.timedOut) {
    customMsg(`校验超时（${Date.now() - t0}ms）：线索可能太少，求解器跑不动。`, 'bad')
    return
  }
  if (r.count === 0) {
    customMsg('无解：这组数字互相矛盾（或必然成环）。', 'bad')
  } else if (r.count === 1) {
    customMsg(`唯一解 ✓（${Date.now() - t0}ms）`, 'ok')
  } else {
    customMsg(`有 ${r.count}+ 个解，不是唯一解。`, 'bad')
  }
}

/* ———————————————————— 落子特效 + 音效 ———————————————————— */

let lastFxAt = 0

/** 落子/排除的特效：弦振（线段）或形变（图形）+ 对应音效 */
function playCellFx(cell: number, positive: boolean, force = false): void {
  // 拖拽连续涂时节流：同一时间只保留一个音/一段动画
  if (!force) {
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    if (now - lastFxAt < 70) return
    lastFxAt = now
  }
  if (!session) return
  const svg = currentSvg()
  if (!svg) return
  const m = metricsFor(session.puzzle)
  const cx = cell % m.width
  const cy = Math.floor(cell / m.width)
  const center = cellCenter(m, cx, cy)
  const el = svg.querySelector<SVGElement>(`[data-cell="${cell}"]`)
  const streak = bumpStreak(positive ? 'pos' : 'neg')
  if (positive) fxPositive({ svg, positiveEl: el, center }, streak)
  else fxNegative({ svg, positiveEl: null, negativeEl: el, center }, streak)
}

function toggleMute(): void {
  const next = !isMuted()
  setMuted(next)
  const btn = document.querySelector<HTMLButtonElement>('#btn-mute')
  if (btn) btn.textContent = next ? '音效：关' : '音效：开'
}

function setButtonsDisabled(disabled: boolean): void {
  // 注意：不禁 btn-logic —— 播放中要保留「停止演示」的入口
  for (const id of ['btn-check', 'btn-undo', 'btn-redo', 'btn-hint', 'btn-solve', 'btn-clear'] as const) {
    const el = document.querySelector<HTMLButtonElement>(`#${id}`)
    if (el) el.disabled = disabled
  }
  const board = document.querySelector<HTMLElement>('#board')
  if (board) board.style.pointerEvents = disabled ? 'none' : ''
}

/* ———————————————————— 键盘 ———————————————————— */

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  // 待确认删除时，Esc 先取消确认
  if (e.key === 'Escape' && pendingDeleteId) {
    e.preventDefault()
    pendingDeleteId = null
    renderPuzzleList()
    return
  }
  const k = e.key.toLowerCase()

  // —— 自定义题板键盘录入（编辑器打开时优先于全局快捷键）——
  if (customEditorOpen()) {
    // 0–4 填数并右移一格（行末自动换行到下一行行首）
    if (k >= '0' && k <= '4') {
      e.preventDefault()
      setCustomClue(customCursorX, customCursorY, Number(k) as VertexNumber)
      moveCustomCursor(1, 0)
      return
    }
    // . / 退格 / Delete / 空格 清空（退格左移，其余右移；越界自动换行）
    if (k === '.' || k === 'backspace' || k === 'delete' || k === ' ') {
      e.preventDefault()
      setCustomClue(customCursorX, customCursorY, null)
      if (k === 'backspace') moveCustomCursor(-1, 0)
      else moveCustomCursor(1, 0)
      return
    }
    if (k === 'arrowleft') {
      e.preventDefault()
      moveCustomCursor(-1, 0)
      return
    }
    if (k === 'arrowright') {
      e.preventDefault()
      moveCustomCursor(1, 0)
      return
    }
    if (k === 'arrowup') {
      e.preventDefault()
      moveCustomCursor(0, -1)
      return
    }
    if (k === 'arrowdown') {
      e.preventDefault()
      moveCustomCursor(0, 1)
      return
    }
    if (k === 'enter' || k === 'tab') {
      e.preventDefault()
      if (e.shiftKey) moveCustomCursor(-1, 0)
      else moveCustomCursor(1, 0)
      return
    }
    if (k === 'home') {
      e.preventDefault()
      selectCustomVertex(0, customCursorY)
      return
    }
    if (k === 'end') {
      e.preventDefault()
      selectCustomVertex(customW, customCursorY)
      return
    }
    if (k === 'escape') {
      e.preventDefault()
      closeCustomEditor()
      return
    }
  }

  if (k === 'z' && !e.shiftKey) {
    e.preventDefault()
    undo()
  } else if ((k === 'z' && e.shiftKey) || k === 'y') {
    e.preventDefault()
    redo()
  } else if (k === 'c') {
    check()
  } else if (k === 'r') {
    pickRandomPuzzle()
  } else if (k === 'h') {
    hint()
  } else if (k === 's') {
    showSolution()
  } else if (k === 'l') {
    runLogicSolver()
  } else if (k === 'p') {
    e.preventDefault()
    toggleLogicPause()
  } else if (k === 'm') {
    toggleMute()
  } else if (k === 'escape') {
    clearBoard()
  } else if (k === '0') {
    resetView()
  } else if (k === '+' || k === '=') {
    setZoom(zoom * 1.15)
  } else if (k === '-') {
    setZoom(zoom / 1.15)
  }
})

/* ———————————————————— 绑定按钮 ———————————————————— */

$('#btn-random').addEventListener('click', pickRandomPuzzle)
$('#btn-mute').addEventListener('click', toggleMute)
$('#btn-custom').addEventListener('click', openCustomEditor)
$('#btn-check').addEventListener('click', check)
$('#btn-undo').addEventListener('click', undo)
$('#btn-redo').addEventListener('click', redo)
$('#btn-hint').addEventListener('click', hint)
$('#btn-logic').addEventListener('click', () => {
  void runLogicSolver()
})
$('#btn-solve').addEventListener('click', showSolution)
$('#btn-clear').addEventListener('click', clearBoard)
$('#zoom-in').addEventListener('click', () => setZoom(zoom * 1.15))
$('#zoom-out').addEventListener('click', () => setZoom(zoom / 1.15))
$('#zoom-reset').addEventListener('click', resetView)
$('#custom-regen').addEventListener('click', regenCustomGrid)
$('#custom-apply').addEventListener('click', loadCustomPuzzle)
$('#custom-save').addEventListener('click', saveCustomPuzzle)
$('#custom-unique').addEventListener('click', checkCustomUnique)
$('#custom-close').addEventListener('click', closeCustomEditor)

bindBoard()
bindLogicProgress()

/* ———————————————————— 启动 ———————————————————— */

refreshLibrary()

selectPuzzle(puzzles[0]!)
setStatus(`已载入「${puzzles[0]!.name}」。左键在格子里画对角线。`)

// 便于调试
;(window as unknown as { __xiexian: unknown }).__xiexian = {
  get session() {
    return session
  },
  validate: () => (session ? validate(session.state, session.puzzle) : null),
  setCell: (i: number, v: CellState) => setCells([{ index: i, value: v }]),
  runLogicSolver,
  stopLogic,
  seekLogic: (n: number) => seekLogicFrame(n),
  toggleLogicPause,
  get logic() {
    return {
      playing: logicPlaying,
      paused: logicPaused,
      frame: logicFrame,
      total: logicTotal,
      hasBase: logicBase !== null,
      panelVisible: !(document.querySelector<HTMLElement>('#logic-progress')?.hidden ?? true),
      pauseText: document.querySelector<HTMLButtonElement>('#logic-pause-btn')?.textContent ?? '',
    }
  },
}
