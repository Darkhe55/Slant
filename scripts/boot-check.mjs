import { chromium } from 'playwright-core'
import { homedir } from 'node:os'
import path from 'node:path'

const EXE =
  process.env.PLAYWRIGHT_CHROME_PATH ??
  path.join(homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe')

const b = await chromium.launch({ headless: true, executablePath: EXE })
const p = await b.newPage({ viewport: { width: 1280, height: 900 } })
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
p.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text())
})
await p.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle' })
console.log('题目数:', await p.locator('.puzzle-item').count())
console.log('当前题:', await p.locator('.puzzle-item.active .title').textContent())
console.log('顶点数字:', await p.locator('.board-svg .clue').count())
console.log('对角线:', await p.locator('.board-svg .diag:not(.ghost)').count())
console.log('状态栏:', await p.locator('#status').textContent())
console.log('JS 报错:', errs.length ? errs.join(' | ') : '无')
await b.close()
