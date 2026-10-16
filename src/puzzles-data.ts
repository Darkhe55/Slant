/* 自动生成，勿手改。scripts/gen-puzzles.mts（npm run gen） */
export type RawPuzzle = {
  id: string
  name: string
  width: number
  height: number
  difficulty: 'easy'|'medium'|'hard'|'custom'
  series: string
  /** 顶点数字串：'.' = 无数字，'0'-'4'；length = (W+1)*(H+1)，row-major */
  clues: string
  /** 参考解：'\\' = 反斜杠，'/' = 斜杠；length = W*H，row-major */
  solution: string
}

export const RAW_PUZZLES: RawPuzzle[] = [
  { id: "starter-4x4", name: "入门 · 4×4", width: 4, height: 4, difficulty: "easy", series: "starter", clues: "110201141103212.313010111", solution: "\\\\/\\\\/\\\\//\\//\\\\\\" },
  { id: "starter-5x5-A", name: "入门 · 5×5 A", width: 5, height: 5, difficulty: "easy", series: "starter", clues: "01120112.1.1211.2104.2302121..01.110", solution: "///\\///\\\\/\\//\\//\\/\\\\\\\\///" },
  { id: "starter-5x5-B", name: "入门 · 5×5 B", width: 5, height: 5, difficulty: "easy", series: "starter", clues: "01.1.01.12.121.2211.2122.3.330.02101", solution: "//\\\\\\/\\\\\\\\\\\\\\\\\\\\\\\\///\\//\\" },
  { id: "classic-6x6-A", name: "经典 · 6×6 A", width: 6, height: 6, difficulty: "medium", series: "classic", clues: "0.1.2...124121.32122111.1321..2.1121221.4..102.0.", solution: "/\\\\/\\\\///\\\\\\/\\\\\\\\\\//\\/\\\\//\\\\\\///\\//\\" },
  { id: "classic-6x6-B", name: "经典 · 6×6 B", width: 6, height: 6, difficulty: "medium", series: "classic", clues: "021.2011132.4..21..1.03.331..12.230.33..3..011.01", solution: "/\\\\/\\///\\//\\\\\\\\\\///\\/\\\\/\\\\/\\\\\\/\\\\\\/\\" },
  { id: "classic-7x7-A", name: "经典 · 7×7 A", width: 7, height: 7, difficulty: "medium", series: "classic", clues: ".0..2..1.22..41..22.11.01222......21.2212114.21.13121..2.120..20", solution: "\\/\\/\\//\\/\\//\\/\\/\\\\//\\\\/\\\\//\\//\\///\\\\//\\\\\\\\\\\\/\\/\\/" },
  { id: "classic-8x8-A", name: "经典 · 8×8 A", width: 8, height: 8, difficulty: "hard", series: "classic", clues: "..10112....2.2221..4..22121..311.140.1313....1...2.3.2022.211.112..2...0..1.1.01.", solution: "\\\\\\///\\\\\\/////\\//\\/\\\\\\\\/\\\\\\\\/\\/\\\\/\\//\\\\\\\\\\\\///\\////\\\\/////////\\\\" },
  { id: "challenge-9x9", name: "挑战 · 9×9", width: 9, height: 9, difficulty: "hard", series: "challenge", clues: "0.0.011......2312.1..12....2....22..1.2..3.22.312..1212321.2.232.3..3.2....1...2.312311.300.11......", solution: "/\\/\\////\\///\\\\////\\/////\\\\\\\\\\\\\\\\//\\\\/\\\\\\\\/\\\\\\\\\\\\///\\////\\//\\\\/\\\\/\\\\//\\//\\\\\\\\\\///\\" },
]
