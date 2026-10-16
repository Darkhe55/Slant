# 斜线（Gokigen Naname）设计与数据结构

> 参考项目：`test/数回`（Slitherlink）。本项目沿用其「逻辑层 / 渲染层 / UI 层」分层与题库静态化思路，
> 但棋盘模型更简单：**格子三态 + 顶点数字**，不需要 padding 边。

## 规则

1. 每格必须填入一条对角线：`\`（左上→右下）或 `/`（右上→左下）
2. 顶点上的数字（0–4）= 经过该顶点的对角线条数；没有数字的顶点不约束
3. 所有对角线**不得闭合成环**

## 坐标与索引

设题面 `width = W`、`height = H`（格数）。

| 元素 | 范围 | 数量 | 存储 |
|------|------|------|------|
| 格子 `(cx, cy)` | `0≤cx<W`, `0≤cy<H` | `W*H` | `GameState.cells`（row-major） |
| 顶点 `(px, py)` | `0≤px≤W`, `0≤py≤H` | `(W+1)*(H+1)` | `Puzzle.clues`（row-major） |

扁平索引：

```ts
cellIndex(w, cx, cy) = cy * w + cx
clueIndex(w, px, py) = py * (w + 1) + px
```

与数回不同：这里**没有 padding**。数回要给每个顶点补 4 条边，是因为环上顶点度数必须为 2；
本游戏的顶点度数天然是 0–4，边界顶点只是周围格子少一些，`vertexIncidents` 里做范围判断即可。

## 格子 ↔ 顶点 的关联（关键）

格子 `(cx, cy)` 四角：

```
tl = (cx,   cy)     tr = (cx+1, cy)
bl = (cx,   cy+1)   br = (cx+1, cy+1)
```

- `\` 连接 **tl–br**
- `/` 连接 **tr–bl**

反过来，顶点 `(px, py)` 周围有四格，每格只有取特定方向才会连到本顶点：

| 格子 | 顶点是它的哪个角 | 需要方向 |
|------|------------------|----------|
| `(px-1, py-1)` | 右下 br | `\` |
| `(px,   py-1)` | 左下 bl | `/` |
| `(px-1, py)`   | 右上 tr | `/` |
| `(px,   py)`   | 左上 tl | `\` |

这个「对称」结构（NW/SE 要 `\`，NE/SW 要 `/`）是数字校验和解题器剪枝的基础，
封装在 `state.ts: vertexIncidents()` 与 `solver.ts: cellVertexDirs()`。

## 类型

```ts
enum CellState { Unknown = 0, Backslash = 1, Slash = 2 }
type VertexNumber = 0 | 1 | 2 | 3 | 4 | null

interface Puzzle {
  id, name, width, height,
  clues: VertexNumber[]        // length = (W+1)*(H+1)
  solution?: CellState[]       // 参考解，提示/显示解用；自定义题没有
  difficulty: 'easy' | 'medium' | 'hard' | 'custom'
}

interface GameState { puzzleId, width, height, cells: CellState[] }
interface Move { index, from, to }

interface ValidationResult {
  badVertices: VertexCount[]   // 明确冲突：over（超上限）/ stuck（补不上了）
  satisfiedVertices: number[]  // 已满足的顶点（渲染成灰色）
  filled, unknown,
  hasLoop, loopCells,          // 环路（红线高亮）
  solved
}
```

## 校验（validate.ts）

1. **数字**：逐顶点数经过它的斜线数
   - `actual === expected` → 满足
   - `actual > expected` → `over`，标红
   - `actual + 周围空格数 < expected` → `stuck`，标红
   - 其余（还差几条但周围还有空格）→ 推进中，不标红（避免开局一片红）
2. **环路**：把斜线看成「顶点—顶点」的边，用并查集分连通分量。
   无向图中**分量内 边数 ≥ 顶点数 ⟺ 含环**；且「有环」具有单调性（加边不会消环），
   所以同一个判定可以直接用作解题器剪枝。
3. **完成**：无空格 + 无冲突数字 + 无环。

## 求解器（solver.ts，暴力枚举）

回溯按 row-major 顺序给格子赋值，剪枝：

- 数字顶点：`已连数 ≤ 数字` 且 `已连数 + 未定邻格数 ≥ 数字`
- 环路单调性：一条边的两端已连通 → 立刻成环 → 剪枝
- 预检：数字顶点的邻格总数 < 数字 → 直接无解

导出 `solvePuzzle()` / `countSolutions(limit)`，用于题库生成与自定义题的「唯一解校验」。

> ⚠️ 实现约定：`assign()` 总是完整改动状态（cells / cnt / unknownAround / DSU），
> 由 `unassign()` 无条件完整回滚。早期版本在「成环剪枝」处提前 return 而调用方仍然回滚，
> 导致计数器污染、放出非法解——已修复并由 `scripts/check.mts` 兜底校验。

## 逻辑解谜器（logic.ts）

人类规则推理：不枚举解，一步步推必然结论，每步带理由，由 UI 逐条动画播放。

```ts
planLogicSolve(puzzle, start?): LogicPlan
// { supported, reason, steps: LogicStep[], complete, ms, cells, conflicts }
```

**主循环**：只要还有规则推出新结论，就从头再扫一遍（新结论会解锁更多推理）；
规则 1-4 全部推不动时，启用规则 5（染色枚举），推得新结论后同样回到循环头部。

```ts
while (progress && !conflicts) {
  progress = false
  for (const rule of RULES) {
    const produced = rule.fn(ctx)   // 规则边推边落子到 ctx.cells，同轮内立即可见
    if (produced.length) { steps.push(...produced); progress = true }
  }
  if (!progress) {
    // 规则 1-4 推不动 → 染色枚举（coloring.ts）
    const produced = ruleColoringEnumerate(ctx)
    if (produced.length) { steps.push(...produced); progress = true }
  }
}
```

**规则 1 · 顶点饱和度**（`ruleVertexSaturation`）
对每个带数字的顶点，数周围四格：`conn` = 已填成「连朝本顶点」的格数，
`off` = 已填成「背朝」的格数，`unk` = 未定的格数（`k = conn + off + unk`）：

| 条件 | 结论 |
|------|------|
| `conn === N`（连接数已足够） | 剩余 `unk` 格全部填**背朝**方向 |
| `conn + unk === N`（非连接数已和数字互补，等价 `off === k - N`） | 剩余 `unk` 格全部填**连朝**方向 |
| `conn > N` | 记一条冲突，中止推理 |

> 顶点数字 0 和 4 是规则 1 的边界特例，不需要单独写规则。

**规则 2 · 环路规避**（`ruleLoopAvoidance`）
对每个未定格子分别试填两个方向：若某个方向会把两个**已经连通**的顶点接上，
就等于立刻闭合成环 → 该方向非法，另一个方向随之确定。
依据：无向图中「分量内 边数 ≥ 顶点数 ⟺ 含环」，且**有环是单调的**（加边不消环）。
实现上每轮只建一次并查集，之后每格只需两次 `find`。

**规则 3/4 · 相邻数字对的非公共格额度推导**（`ruleAdjacentPair`，「相邻的 1 / 相邻的 3」的推广）

设 V、Q 正交相邻，数字 N1、N2，S = N1 + N2。任一完整解都满足恒等式：

    S = g +（非公共格连向各自归属顶点的条数）

每个公共格的两个对角端点正是 V 和 Q，必连向二者之一；每个非公共格至多连向它归属的顶点。
记 c = 已确认相连的非公共格数、b = 已确认相背数、n = 非公共格总数：

| 条件 | 结论 |
|------|------|
| `c + g ≥ S`（规则 3） | 连接额度已用光，剩余空格全部填**相背** |
| `b = n + g − S`（规则 4；墙内完整时即 `b + 2 + S = 8`） | 相背数把余量吃光，剩余空格全部填**相连** |

特例回归：相邻两个 1（S=2, g=2）→ `c ≥ 0` 恒成立 → 非公共格全相背（连上去会让另一个 1 变 2）；
相邻两个 3（S=6, g=2, n=4）→ `b = 0` 即触发 → 非公共格全相连。混合对（1-2、2-2、2-3、1-0…）
等额度露头时同样可推。

**墙边处理**：g 与 n 一律按盘面内**实际存在**的格子数代入（`pairCells` 只收盘面内的格子），
不再要求「两个公共格都存在」——顶边/底边的水平对只剩 1 个公共格，墙边顶点可能只剩 0–2 个
非公共格，公式自动弱化或改结论。例如角上相邻两个 1（(0,0)-(1,0)：g=1, n=1）→ `b = 0`
触发规则 4，唯一非公共格必须相连（另一个顶点的额度被它仅有的格子占满）；顶边相邻两个 1
（(1,0)-(2,0)：g=1, n=2, S=2）→ 两条款都不触发，推不出结论（`logic-test` 有定向单测盯着）。

**规则 5 · 朝向染色枚举**（`coloring.ts`，仿数回色块染色的「并查集 + 枚举排除」）

把每个格子的两种朝向（\ 与 /）看成两种颜色。约束来源：某顶点只剩两个未定格、
且恰好其中一个必须连向该顶点时（conn < N < conn + 2）——

| 两格关系 | 结论 | 原理 |
|---------|------|------|
| 相邻（如左上与右上） | **同色**（朝向相同） | 相邻格的连朝方向一为 \ 一为 /，「恰一连」逼出同向 |
| 对角（如左上与右下） | **异色**（朝向相反） | 对角格的连朝方向相同，「恰一连」逼出反向 |

约束用**带权并查集**（parity DSU）传播：同色 parity 0、异色 parity 1，传递闭包自动成立；
若推出奇环（矛盾）说明当前进度无解，放弃本轮。无约束的未定格自成一类。

主循环推不动后启用：剩余未定格各自落入颜色类，按类枚举（每类两种整体朝向，共 2^k 种），
用**「顶点数字全对 + 不成环」**排除非法填法（复用 `validate`）；所有合法填法中取值一致的
格子即为必然结论，回灌主循环。上限 16 个颜色类 / 1.5s，超限整体作废（部分枚举结果不可用）。
贴墙无需特例：未定格按实际存在性统计，相邻/对角按实际坐标判断。

**关于「一条直线上除了两端点外都是 2 ⟹ 两端点连通」**：**不成立**，不能当规则。
反例（4×4，主对角线上 (1,1)(2,2) 都是 2、其余无数字）存在完整合法解使
(0,0) 与 (3,3) 分属两条链——每个内部 2 都可以从「沿线那格」逃逸到线外，
链路不必沿线走。要实现 2 链连通性需要全图连通分量跟踪 + 假设推演，
不是单条局部规则。

**当前成绩**（`npm run logic-test`，含 6 条定向单测）：

| 题 | 规则1 | 规则2 | 规则3 | 规则4 | 规则5 | 合计 | 未定 |
|----|-------|-------|-------|-------|-------|------|------|
| 4×4 | 16 | 0 | 0 | 0 | 0 | 16 | 0 |
| 5×5 A | 19 | 1 | 4 | 1 | 0 | 25 | 0 |
| 5×5 B | 15 | 0 | 4 | 6 | 0 | 25 | 0 |
| 6×6 A | 18 | 1 | 10 | 7 | 0 | 36 | 0 |
| 6×6 B | 23 | 1 | 4 | 8 | 0 | 36 | 0 |
| 7×7 A | 39 | 2 | 7 | 1 | 0 | 49 | 0 |
| 8×8 A | 34 | 3 | 17 | 10 | 0 | 64 | 0 |
| 9×9 | 35 | 3 | 26 | 7 | 10 | 81 | 0 |

引入染色枚举后 **9×9 从剩 10 格变为全部推完**（规则 5 贡献 10 步：4 个颜色类、16 种填法仅 1 种合法），
其余题目规则 1-4 已足够。推得的结论与参考解**完全一致**、无矛盾（脚本逐题校验）。

**待实现**（接口已稳定）：

- 规则 6 · 单格二选一 + 传播：假设某格填 A，跑一遍规则 1-5 不动点，出现矛盾则填 B
  （染色枚举已覆盖大部分场景，这条是更轻量的补充）
- 规则 7 · 全图连通分量跟踪（配合规则 2 做跨单元格的环路预判）

## 题库生成（scripts/gen-puzzles.mts）

1. 随机造一个**无环**完整填法（DFS + 并查集避环）
2. 由填法算出全顶点数字
   ——注意：**全数字题也可能多解**（两种填法可以给出完全相同的顶点数字向量），
   所以这一步要用 `countSolutions` 验证，不唯一就换一个参考解重来
3. 随机删数字，每删一个都校验「仍唯一解」，否则回滚
4. 落盘到 `src/puzzles-data.ts`（运行期只读，不在 import 时生成）

## 渲染与交互（render.ts / main.ts）

- 原生 SVG，无框架；`BASE_CELL = 48`，描边/字号按 `k = cell/48` 等比缩放
- 分层：盘面底 → 网格导线 → **悬停层**（`<g class="hover-layer">`）→ 对角线 → 顶点 → 数字
  - 悬停层单独更新，不重建整张 SVG，避免拖拽涂写时指针事件被打断
  - 数字用 `paint-order: stroke` 加底色描边，压在斜线上也可读
- 命中检测：viewBox 坐标 → `floor((x-pad)/cell)` 直接算格子
- 手势：
  - 左键点格子：`空 → \ → / → 空`
  - 右键：反向循环
  - 左键按住拖拽：以第一格即将变成的方向连续涂
  - 中键（或点在盘面外）拖拽：平移；滚轮：以光标为锚点缩放
- 撤销栈单元是 `Move[]`（一次手势/一次操作算一步），所以「显示解」「清空」也能一步撤销
- 进度按题 id 存 `localStorage`（`xiexian-save:` 前缀）

## 文件布局

```
index.html            入口
src/types.ts          CellState / VertexNumber / Puzzle / GameState / ValidationResult
src/state.ts          索引换算、格子↔顶点关联、状态读写、存档序列化
src/validate.ts       数字校验 + 环路检测（并查集，E≥V 判定）
src/solver.ts         暴力求解/计数（题库生成、唯一解校验）
src/logic.ts          ★ 逻辑解谜器预留位置
src/render.ts         SVG 渲染、命中检测、悬停层、缩放度量
src/puzzles.ts        题库解析（字符串 → Puzzle）
src/puzzles-data.ts   ★ 自动生成，勿手改
src/main.ts           UI 外壳、手势、工具栏、快捷键、自定义题板
src/styles.css        暖色主题（与数回一致）
scripts/gen-puzzles.mts  题库生成
scripts/check.mts        题库审计（合法性 + 唯一解）
scripts/ui-check.mjs     playwright 冒烟测试
```

## 命令

```bash
npm run dev       # 开发服务 127.0.0.1:5174
npm run build     # tsc --noEmit + vite build
npm run preview   # 预览 dist
npm run gen       # 重新生成题库（改 scripts/gen-puzzles.mts 里的 SPECS）
npm run check     # 审计题库
node scripts/ui-check.mjs   # 冒烟测试（需先 preview）
```