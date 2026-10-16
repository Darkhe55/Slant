/**
 * 冒烟测试：用 playwright 跑一遍核心交互。
 * 用法：先 `npx vite preview --port 5174`（或 npm run preview），再 `node scripts/ui-check.mjs`
 */
import { chromium } from 'playwright-core'
import { homedir } from 'node:os'
import path from 'node:path'

const EXE =
  process.env.PLAYWRIGHT_CHROME_PATH ??
  path.join(homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe')
const BASE = 'http://127.0.0.1:5174/'

async function waitForServer(url, timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('preview server 没起来（先跑 npm run preview）')
}

const results = []
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra })
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`)
}

try {
  await waitForServer(BASE)
  const browser = await chromium.launch({ headless: true, executablePath: EXE })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  await page.goto(BASE, { waitUntil: 'networkidle' })

  ok('无 JS 报错', errors.length === 0, errors.join(' | '))
  ok('题库渲染', (await page.locator('.puzzle-item').count()) === 8)
  ok('棋盘 SVG 渲染', (await page.locator('svg.board-svg').count()) === 1)

  // 第一题：4×4 → 5×5 顶点 = 25 个数字位置（含空格）
  const clueCount = await page.locator('.board-svg .clue').count()
  ok('4×4 顶点数字渲染', clueCount >= 10, `clue=${clueCount}`)

  // 点一个格子：应出现一条对角线
  const cellCenter = await page.evaluate(() => {
    const svg = document.querySelector('svg.board-svg')
    const vb = svg.viewBox.baseVal
    return { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2, w: vb.width, h: vb.height }
  })
  const box = await page.locator('svg.board-svg').boundingBox()
  // 格子 (1,1) 中心 → viewBox 坐标换算
  const clickCell = async (cx, cy) => {
    const pt = await page.evaluate(
      ([x, y]) => {
        const svg = document.querySelector('svg.board-svg')
        const m = svg.getScreenCTM()
        const p = svg.createSVGPoint()
        p.x = x
        p.y = y
        const s = p.matrixTransform(m)
        return { x: s.x, y: s.y }
      },
      [
        (await page.evaluate(() => document.querySelector('svg.board-svg').viewBox.baseVal.x)) +
          (cx + 0.5) * 48 +
          48 * 0.42,
        0,
      ],
    )
    void pt
  }
  void clickCell
  void cellCenter
  void box

  // 直接用暴露的调试接口验证玩法闭环
  const solved = await page.evaluate(async () => {
    const api = window.__xiexian
    const p = api.session.puzzle
    const sol = p.solution
    for (let i = 0; i < sol.length; i++) api.setCell(i, sol[i])
    await new Promise((r) => setTimeout(r, 50))
    const v = api.validate()
    return { solved: v.solved, status: document.querySelector('#status').textContent }
  })
  ok('按参考解填满 → 判定完成', solved.solved === true, solved.status)

  // 撤销应退回未完成
  const afterUndo = await page.evaluate(async () => {
    const before = document.querySelectorAll('.board-svg .diag:not(.ghost)').length
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }))
    await new Promise((r) => setTimeout(r, 30))
    const after = document.querySelectorAll('.board-svg .diag:not(.ghost)').length
    return { before, after }
  })
  ok('Z 键撤销生效', afterUndo.after < afterUndo.before, `${afterUndo.before} → ${afterUndo.after}`)

  // 重做
  const afterRedo = await page.evaluate(async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', shiftKey: true, bubbles: true }),
    )
    await new Promise((r) => setTimeout(r, 30))
    return document.querySelectorAll('.board-svg .diag:not(.ghost)').length
  })
  ok('Shift+Z 重做生效', afterRedo === afterUndo.before, `${afterRedo}`)

  // 逻辑解题：清空后开始演示 → 再按一次停止
  await page.evaluate(() => {
    const n = window.__xiexian.session.puzzle.width * window.__xiexian.session.puzzle.height
    for (let i = 0; i < n; i++) window.__xiexian.setCell(i, 0)
  })
  await page.click('#btn-logic')
  await page.waitForTimeout(250)
  const logicBtn = await page.locator('#btn-logic').textContent()
  const logicStatus = await page.locator('#status').textContent()
  ok(
    '逻辑解题开始演示（规则 1/2）',
    logicBtn === '停止演示' && /\[1\/\d+\]/.test(logicStatus || ''),
    logicStatus,
  )
  await page.click('#btn-logic')
  await page.waitForTimeout(200)
  const stopStatus = await page.locator('#status').textContent()
  ok('逻辑解题可中途停止', /已停止/.test(stopStatus || ''), stopStatus)

  // 随机抽题
  await page.click('#btn-random')
  const randomName = await page.locator('.puzzle-item.active .title').textContent()
  ok('随机抽题', !!randomName, randomName || '')

  // 真实鼠标点击一格（验证命中检测）
  await page.evaluate(() => {
    window.__xiexian.setCell(0, 0)
  })
  await page.locator('svg.board-svg').hover()
  const svgBox = await page.locator('svg.board-svg').boundingBox()
  const vb = await page.evaluate(() => {
    const v = document.querySelector('svg.board-svg').viewBox.baseVal
    return { x: v.x, y: v.y, w: v.width, h: v.height }
  })
  const pad = 48 * 0.42
  // 点格子 (0,0) 中心
  const px = svgBox.x + ((pad + 0.5 * 48 - vb.x) / vb.w) * svgBox.width
  const py = svgBox.y + ((pad + 0.5 * 48 - vb.y) / vb.h) * svgBox.height
  const beforeClick = await page.evaluate(() => window.__xiexian.session.state.cells[0])
  await page.mouse.click(px, py)
  const afterClick = await page.evaluate(() => window.__xiexian.session.state.cells[0])
  ok('鼠标点击格子可落子', afterClick !== beforeClick, `${beforeClick} → ${afterClick}`)

  // 自定义题板
  await page.click('#btn-custom')
  ok('自定义编辑器打开', await page.locator('#custom-editor').isVisible())
  const customCells = await page.locator('.custom-cell').count()
  ok('自定义网格 6×6 顶点', customCells === 36, String(customCells))
  await page.click('#custom-close')

  await page.screenshot({ path: 'output/ui-check.png', fullPage: true })

  await browser.close()
} catch (err) {
  console.error('运行异常：', err)
  process.exitCode = 1
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) process.exit(1)
