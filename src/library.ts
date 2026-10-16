/**
 * 自定义题库：把玩家自己摆的题板存进 localStorage（从 test/数回 移植，格式独立）。
 *
 * 存储形态与 puzzles-data.ts 的字符串编码一致：顶点数字 0–4，'.' 表示无数字，
 * 一个题板编码为长度 (W+1)*(H+1) 的字符串，省空间也方便肉眼检查。
 */

import type { Puzzle, VertexNumber } from './types'

const KEY = 'xiexian-saved-puzzles'

export type SavedPuzzle = Puzzle & {
  savedAt: number
}

function parseClues(s: string): VertexNumber[] {
  return [...s].map((ch) => (ch === '.' ? null : (Number(ch) as 0 | 1 | 2 | 3 | 4)))
}

function encodeClues(clues: VertexNumber[]): string {
  return clues.map((c) => (c === null ? '.' : String(c))).join('')
}

export function loadSavedPuzzles(): SavedPuzzle[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as Array<{
      id: string
      name: string
      width: number
      height: number
      clues: string
      difficulty?: string
      savedAt: number
    }>
    return arr
      .filter(
        (x) =>
          x &&
          x.id &&
          x.width > 0 &&
          x.height > 0 &&
          typeof x.clues === 'string' &&
          x.clues.length === (x.width + 1) * (x.height + 1),
      )
      .map((x) => ({
        id: x.id,
        name: x.name || `自定义 · ${x.width}×${x.height}`,
        width: x.width,
        height: x.height,
        difficulty: (x.difficulty as Puzzle['difficulty']) || 'custom',
        clues: parseClues(x.clues),
        savedAt: x.savedAt || Date.now(),
      }))
  } catch {
    return []
  }
}

function persistSavedPuzzles(list: SavedPuzzle[]): void {
  const payload = list.map((p) => ({
    id: p.id,
    name: p.name,
    width: p.width,
    height: p.height,
    difficulty: p.difficulty,
    clues: encodeClues(p.clues),
    savedAt: p.savedAt,
  }))
  localStorage.setItem(KEY, JSON.stringify(payload))
}

/** 追加或覆盖同 id，返回最新列表 */
export function savePuzzleToLibrary(p: Puzzle): SavedPuzzle[] {
  const list = loadSavedPuzzles()
  const item: SavedPuzzle = { ...p, difficulty: 'custom', savedAt: Date.now() }
  const i = list.findIndex((x) => x.id === p.id)
  if (i >= 0) list[i] = item
  else list.push(item)
  persistSavedPuzzles(list)
  return list
}
