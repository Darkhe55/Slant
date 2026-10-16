/**
 * 斜线（Gokigen Naname / ごきげんななめ）核心类型
 *
 * 规则：
 * 1. 每格必须填入一条对角线：\ 或 /
 * 2. 顶点上的数字 = 经过该顶点的对角线条数（0–4）
 * 3. 所有对角线不能形成闭合环路
 */

/** 格子状态：未定 / 反斜杠 \（左上→右下）/ 斜杠 /（右上→左下） */
export const enum CellState {
  Unknown = 0,
  Backslash = 1,
  Slash = 2,
}

/** 顶点数字：0–4 或 null（无数字约束） */
export type VertexNumber = 0 | 1 | 2 | 3 | 4 | null

export interface Puzzle {
  id: string
  name: string
  width: number
  height: number
  /** 顶点数字，row-major，length = (W+1)*(H+1) */
  clues: VertexNumber[]
  /** 参考解（提示 / 显示解用），row-major，length = W*H；自定义题可能缺失 */
  solution?: CellState[]
  difficulty: 'easy' | 'medium' | 'hard' | 'custom'
}

export interface GameState {
  puzzleId: string
  width: number
  height: number
  /** 格子状态，row-major，length = W*H */
  cells: CellState[]
}

export interface Move {
  index: number
  from: CellState
  to: CellState
}

export interface VertexCount {
  px: number
  py: number
  expected: VertexNumber
  actual: number
  /** over = 已超过数字；stuck = 还差几条但周围没有空格可补了 */
  kind: 'over' | 'stuck'
}

export interface ValidationResult {
  /** 有数字但对不上的顶点 */
  badVertices: VertexCount[]
  /** 已经满足的顶点（clues 扁平索引） */
  satisfiedVertices: number[]
  /** 已填格子数 */
  filled: number
  /** 未填格子数 */
  unknown: number
  /** 是否存在环路（规则禁止） */
  hasLoop: boolean
  /** 成环涉及的格子索引（用于高亮） */
  loopCells: number[]
  /** 全部填满 + 数字全对 + 无环 */
  solved: boolean
}

/** 逻辑解谜器的一条推理结论 */
export interface LogicStep {
  cell: number
  value: CellState
  /** 人类可读的推理依据 */
  reason: string
}
