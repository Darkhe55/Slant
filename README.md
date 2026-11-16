# 划斜线 Gokigen Naname

一个基于 Web 的画斜线（Gokigen Naname）谜题游戏，原生 SVG 渲染，内置逻辑解题器。

## 在线体验

```bash
npm install
npm run dev
```

浏览器打开终端显示的地址（默认 `http://localhost:5174`）。

## 游戏规则

- 每格必须填入一条对角线：`\` 或 `/`
- 顶点上的数字等于经过该顶点的对角线条数，范围 0–4
- 所有对角线不得闭合成环

## 操作

| 操作 | 说明 |
|------|------|
| 左键点格 | 循环：空 → `\` → `/` → 空 |
| 右键点格 | 反向循环 |
| 按住拖动 | 连续绘制同一方向 |
| 滚轮 / 中键拖拽 | 缩放 / 平移画布 |
| Z / Shift+Z / Y | 撤销 / 重做 |
| C / H / S / Esc | 检查 / 提示一格 / 显示解 / 清空 |
| R / L / P / M | 随机抽题 / 逻辑解题 / 暂停回放 / 音效开关 |
| 0 / + / - | 视图复位 / 放大 / 缩小 |

## 功能

- **题库**：内置多道题，题目均校验唯一解
- **实时校验**：冲突与违规位置即时高亮，满足的条件同步变灰
- **逻辑解题**：规则引擎逐帧回放，显示每一步理由；回放中按钮变为停止，按 `P` 暂停/继续
- **提示一格 / 显示解**：提示优先揭示所有解一致的格子，显示解直接填入可行答案
- **撤销/重做**：按手势分组，一次拖拽只需一步撤销
- **进度保存**：自动保存当前题目进度，刷新不丢失
- **音效特效**：Web Audio 合成拨弦、水滴与落子动画，无外部音频资源
- **缩放/平移**：滚轮缩放，中键或 `Shift` 拖拽平移
- **自定义题板**：摆放顶点数字，支持键盘录入（方向键移动，0–4 填数，`.`/退格清空）；保存到题库后可编辑或删除
- **逻辑推理**：顶点饱和度、环路规避、相邻数字额度推导与朝向染色枚举

## 技术栈

- Vite + TypeScript
- 原生 SVG（无框架）
- Web Audio 合成音效（无外部资源）
- localStorage 存储进度与题库

## 项目结构

```
src/
  main.ts
  render.ts
  logic.ts
  coloring.ts
  solver.ts
  puzzles.ts
  puzzles-data.ts
  state.ts
  validate.ts
  library.ts
  audio.ts
  fx.ts
  styles.css
```

## 命令

```bash
npm run dev       # 开发服务（127.0.0.1:5174）
npm run build     # tsc --noEmit + vite build
npm run gen       # 重新生成题库
npm run check     # 审计题库
npm run logic-test # 逻辑引擎自检
```

## 图片识图导入

```bash
# 预览：识别网格与顶点数字，不写入题库
npm run import-image -- 题图.png

# 识别并追加到题库（会写入参考解）
npm run import-image -- 题图.png --append --name "识图 · 7×7" --verify
```

| 参数 | 说明 |
|------|------|
| `--name 名称` / `--id ID` / `--series 系列` | 题库条目信息 |
| `--append` | 写入 `src/puzzles-data.ts` |
| `--verify` | 额外校验唯一解（超时只警告） |
| `--map 簇号=数字` | 数字 OCR 识别簇人工修正，如 `--map 2=1` |
| `--width W --height H` | 网格线识别失败时手动指定棋盘格数 |
| `--budget N` | 求解节点上限 |
| `--dry` | 只识别并打印顶点数字，不求解、不写入 |

- 识别原理：浅灰网格线投影定位棋盘与顶点 → 每个顶点附近裁切、连通域切字 → 0..4 数字模板 IoU 匹配（无字形 = 无数字）。
- 校验：用 esbuild 现场打包 `src/solver.ts`，检查有解 / 唯一解；导入时把求出的参考解写入题库。
- 数字识别支持 `--map` 人工覆盖；棋盘网格缺失或漏线时可用 `--width/--height` 指定尺寸。
- `npm run gen` 会覆盖 `puzzles-data.ts` 中的导入内容。

