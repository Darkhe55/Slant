import type { CellState, Puzzle, VertexNumber } from './types'
import { CellState as CS } from './types'
import { RAW_PUZZLES, type RawPuzzle } from './puzzles-data'

function parseClues(s: string): VertexNumber[] {
  return [...s].map((ch) => (ch === '.' ? null : (Number(ch) as 0 | 1 | 2 | 3 | 4)))
}

function parseSolution(s: string): CellState[] {
  return [...s].map((ch) => (ch === '\\' ? CS.Backslash : CS.Slash))
}

function toPuzzle(r: RawPuzzle): Puzzle {
  return {
    id: r.id,
    name: r.name,
    width: r.width,
    height: r.height,
    difficulty: r.difficulty,
    clues: parseClues(r.clues),
    solution: parseSolution(r.solution),
  }
}

/** 静态题库（import 即用，无运行时生成） */
export const puzzles: Puzzle[] = RAW_PUZZLES.map(toPuzzle)

export function getPuzzle(id: string): Puzzle | undefined {
  return puzzles.find((p) => p.id === id)
}

export function getReferenceSolution(id: string): CellState[] | null {
  return getPuzzle(id)?.solution ?? null
}

export function randomPuzzle(avoidId?: string): Puzzle {
  const pool = avoidId ? puzzles.filter((p) => p.id !== avoidId) : puzzles
  const list = pool.length ? pool : puzzles
  return list[Math.floor(Math.random() * list.length)]!
}

/** 顶点数字个数 */
export function clueCount(p: Puzzle): number {
  return p.clues.filter((c) => c !== null && c !== undefined).length
}

export function listSeries(): string[] {
  return [...new Set(RAW_PUZZLES.map((r) => r.series))]
}

export function bySeries(series: string): Puzzle[] {
  return RAW_PUZZLES.filter((r) => r.series === series).map(toPuzzle)
}
