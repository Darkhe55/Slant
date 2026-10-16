/**
 * 解题器特效（从 test/数回 移植，各项目独立持有副本）
 *
 * 三套效果：
 *   1. 弦振（落子）：把线段换成 path，沿法向做阻尼正弦抖动 + 光晕
 *   2. 形变（落子，非线段元素如三角/圆）：scale+rotate 轻微抖动 + 光晕
 *   3. 排除：弹跳 pop（scale 0.4→1.35→1）+ 三圈扩散涟漪
 *
 * streak（连拍数）：音高逐级抬升，振幅/涟漪间隔随之收敛，避免叠得太乱。
 */

import { playFor } from './audio'

/** 一次完整弦振/涟漪的名义时长 */
export const FX_ANIM_MS = 720

const NS = 'http://www.w3.org/2000/svg'

/* ———————————————————— 连拍计数 ———————————————————— */

let lastKind = ''
let lastAt = 0
let streakCount = 0

/** 同类型操作间隔 < 1.2s 算一连，返回当前连拍数（1..12） */
export function bumpStreak(kind: string): number {
  const now = typeof performance !== 'undefined' ? performance.now() : 0
  if (kind === lastKind && now - lastAt < 1200) streakCount = Math.min(streakCount + 1, 12)
  else streakCount = 1
  lastKind = kind
  lastAt = now
  return streakCount
}

export function resetStreak(): void {
  lastKind = ''
  lastAt = 0
  streakCount = 0
}

/* ———————————————————— 弦振 ———————————————————— */

function vibrate(line: SVGLineElement, streak: number): void {
  const x1 = Number(line.getAttribute('x1'))
  const y1 = Number(line.getAttribute('y1'))
  const x2 = Number(line.getAttribute('x2'))
  const y2 = Number(line.getAttribute('y2'))
  const cls = line.getAttribute('class') ?? ''
  const dataCell = line.getAttribute('data-cell')

  const path = document.createElementNS(NS, 'path')
  path.setAttribute('class', `${cls} fx-string`)
  if (dataCell) path.setAttribute('data-cell', dataCell)
  path.setAttribute('fill', 'none')
  line.replaceWith(path)

  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  // 连拍越多振幅略收
  const amp0 = Math.min(len * 0.22, 14) / Math.sqrt(streak)
  const duration = FX_ANIM_MS
  const t0 = performance.now()

  const frame = (now: number) => {
    const elapsed = now - t0
    const u = elapsed / duration
    if (u >= 1) {
      path.setAttribute('d', `M ${x1} ${y1} L ${x2} ${y2}`)
      path.classList.remove('fx-string')
      return
    }
    const damp = Math.exp(-4.2 * u)
    const amp = amp0 * damp
    const phase = u * 7.5 * Math.PI * 2
    const N = 14
    let d = `M ${x1} ${y1}`
    for (let i = 1; i < N; i++) {
      const t = i / N
      const envelope = Math.sin(Math.PI * t)
      const off = amp * envelope * Math.sin(phase - t * 2.2 * Math.PI)
      d += ` L ${x1 + dx * t + nx * off} ${y1 + dy * t + ny * off}`
    }
    d += ` L ${x2} ${y2}`
    path.setAttribute('d', d)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

/* ———————————————————— 形变（非线段元素） ———————————————————— */

function wobble(el: SVGElement, streak: number): void {
  const amp = 0.06 / Math.sqrt(streak)
  const rot = 2.4 / Math.sqrt(streak)
  el.classList.add('fx-glow')
  const anim = el.animate(
    [
      { transform: 'scale(1) rotate(0deg)' },
      { transform: `scale(${1 + amp}) rotate(${rot}deg)` },
      { transform: `scale(${1 - amp * 0.5}) rotate(${-rot}deg)` },
      { transform: 'scale(1) rotate(0deg)' },
    ],
    { duration: FX_ANIM_MS, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' },
  )
  anim.onfinish = () => el.classList.remove('fx-glow')
  anim.oncancel = () => el.classList.remove('fx-glow')
}

/* ———————————————————— 涟漪 ———————————————————— */

function ripple(svg: SVGSVGElement, center: { x: number; y: number }, streak: number): void {
  for (let k = 0; k < 3; k++) {
    setTimeout(() => {
      const ring = document.createElementNS(NS, 'circle')
      ring.setAttribute('class', 'fx-ripple')
      ring.setAttribute('cx', String(center.x))
      ring.setAttribute('cy', String(center.y))
      ring.setAttribute('r', '4')
      svg.appendChild(ring)
      const anim = ring.animate(
        [
          { r: 4, opacity: 0.95, strokeWidth: 5 },
          { r: 28, opacity: 0.35, strokeWidth: 2 },
          { r: 48, opacity: 0, strokeWidth: 1 },
        ],
        {
          duration: 560 / Math.sqrt(streak),
          easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)',
          fill: 'forwards',
        },
      )
      anim.onfinish = () => ring.remove()
      anim.oncancel = () => ring.remove()
    }, k * (120 / streak))
  }
}

/* ———————————————————— 对外接口 ———————————————————— */

export interface FxGeom {
  svg: SVGSVGElement | null
  /** 刚落下的正元素（line 走弦振，其它走形变） */
  positiveEl: SVGElement | null
  /** 刚排除的负元素（pop 动画），没有可传 null */
  negativeEl?: SVGElement | null
  /** 格子中心（viewBox 坐标），涟漪从这里扩散 */
  center: { x: number; y: number }
}

/**
 * 落子特效：拨弦音 + 弦振/形变 + 光晕
 * @param lengthRatio 元素长短比（影响音高），短线音高略高
 */
export function fxPositive(geom: FxGeom, streak = 1, lengthRatio = 1): void {
  playFor(true, streak, lengthRatio)
  const el = geom.positiveEl
  if (!geom.svg || !el) return
  if (el instanceof SVGLineElement) vibrate(el, streak)
  else wobble(el, streak)
}

/** 排除特效：水滴音 + pop + 三圈涟漪 */
export function fxNegative(geom: FxGeom, streak = 1): void {
  playFor(false, streak, 1)
  const el = geom.negativeEl
  if (el) {
    el.classList.add('fx-pop')
    setTimeout(() => el.classList.remove('fx-pop'), 650)
  }
  if (geom.svg) ripple(geom.svg, geom.center, streak)
}

/** 只放光晕+轻音，不抖动（提示格等场景） */
export function fxSoft(geom: FxGeom, streak = 1): void {
  playFor(true, streak, 1.1)
  const el = geom.positiveEl
  if (geom.svg && el) {
    el.classList.add('fx-glow')
    setTimeout(() => el.classList.remove('fx-glow'), 650)
  }
}
