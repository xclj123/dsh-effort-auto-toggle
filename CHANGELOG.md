# 变更记录

## 0.2.4 — 2026-11-05
- First-run key tip: while armed with `mode: minimax` and no key, the
  toggle shows a popover — paste a key (saved straight into plugin
  settings), keep the keyless heuristic mode, or dismiss (remembered in
  localStorage).
- Settings-card field descriptions now spell out the keyless heuristic
  fallback.

## 0.2.3 — 2026-11-05

### Added / Fixed — DSH 0.2.2 host compatibility (dual-mode)

DSH 0.2.2-rc.1 changed how the reasoning effort reaches the provider: the
`agent/request` waterfall result is now validated against the step's fixed
model selection, so rewriting `reasoningEffort` there (the 0.2.2 approach)
fails every step with an effort mismatch. Effort changes must go through the
new `agent.model.select()` API before step preparation.

This release makes the plugin **dual-mode**: it probes each event's agent
instance and switches automatically — no separate builds, no config.

- **New hosts (DSH 0.2.2+)**: the decision fires at `agent/inbox/claimed`
  time (synchronous, so the first step of a turn already runs at the
  scheduled tier) via `agent.model.select()`; `agent/request` becomes
  read-only bookkeeping that also queues refinements (tool-continuity
  bumps, delayed minimax verdicts) for the next step. Disarm-restore and
  the forced-thinking `off` clamp ride the same API.
- **Old hosts (DSH ≤ 0.2.1)**: the previous path is untouched — same
  behaviour, same ledger.
- Ledger reasons now distinguish the model.select path (`scheduled
  (model.select path)`, `select X queued for next step`), and first-step
  attribution reuses the claim-time decision (classifier source included).

## 0.2.2 — 2026-10-30

### Fixed

- Badge click now jumps to the head of the badge's own turn. The badge is rendered by the host TurnTailNodeView (`data-turn-tail`), an independent row placed AFTER the assistant content, so the previous nearest-anchor lookup aligned that tail and visually landed on the next message. We now resolve the turn number and align its first `[data-chat-turn]` row exactly like the host `ChatScroller.scrollToTurn`, with the outermost-anchor lookup kept as a fallback.

## 0.2.1 — 2026-10-30

### 修复：消息角标点击回到回复开头不生效
- 行定位改用宿主 ChatScroller 的行标识 `data-chat-anchor-key`（原来的
  `data-chat-flow-kind` 只是类型标记，closest 可能落到嵌套的步骤子行上）。
- 滚动姿势改照宿主 `ChatScroller.align`：对该行与 `[data-conversation-scroll]`
  滚动容器求 delta 后直接写 `scrollTop`（顶部留 24px，同宿主 `scrollToTurn`）。
  原来的裸 `scrollIntoView` 在嵌套滚动容器 + 虚拟列表 scroller 的自管状态下会被
  吞掉或滚错容器；无 scroller 时仍回退 `scrollIntoView`。

## 0.2.0 — 2026-10-30

### 模型自适应档位（breaking 行为改进）
- 档位不再写死 `low/high/max`：每次请求向宿主 `llm` 服务查当前模型的真实档位表
  （`resolveModelInfo(provider, model).reasoning.efforts`，如 glm-5.3 的 `low/high/max`，
  或其它 adapter 的 `low/high/highx/max/ultra`），调度器内部三档语义映射到该表：
  轻 → 最轻档、重 → 最重档、中 → `floor((n-1)*2/3)` 位（3 档→第 2 档，5 档→第 3 档）。
  llm 服务不可用时回落 `DEFAULT_LADDER`（下次重试）。
- 非自动模式手选任意真实档位（如 `ultra`）原样透传，不再被旧白名单误清洗。

### 显示改英文原文
- 按钮点亮时显示档位原文：`自动·low` / `自动·highx` / `自动·ultra`（档名就是 adapter 自己的命名）。
- 消息角标同步：`glm-5.3 · low`。数据源 = modelSelection 会话投影的 `lastUsed`
  （每请求 `request/header` 事件回填的真实档位），点亮时按钮实时跳动。

### 其它
- 启发式打分：≥3 个 heavy 关键词直接 70 分（max 语义）；本版测试覆盖 5 档模型端到端
  （low→low、2 关键词+代码块→highx、5 关键词→ultra）。
- `tools/install.mjs`：不给 `--profile` 时自动探测并列出 `~/.dsh/profiles` 下的 profile；
  yaml 注释块同步新语义。
- `package.json`：description 更新；删除从未使用的构建链 devDependencies
  （tsc/tsdown/vitest/types），测试是零依赖 `node --test`。
- `lib/*.d.ts` 全量对齐 0.2.0 导出（effort.d.ts 补 buildLadder/semanticToLadder/guessSemantic/
  isPickableEffort/assertScheduledEffort/isOffLikeId/DEFAULT_LADDER；index.d.ts 换 autoOn 配置面）。

## 0.1.7 — 2026-10-30

- 按钮档位显示的数据源修复：cordis client ctx 上 `ctx.sessions` 恒 undefined（client 服务
  只经 `ctx.inject` 的 scope 暴露）。宿主侧先例（官方 model-selection）：`ctx.inject(["sessions"],
  (scope) => { const sessions = scope.sessions; ... })`——client.js 现在用嵌套 inject 捕获
  `sessionsRef`，modelFace 回落链 `sessionsRef || ctx.get("sessions") || ctx.sessions`。
  （0.1.6 首次实现按钮档位显示，但走了恒空的 `ctx.sessions`，按钮只显示「自动」不带档。）

## 0.1.6 — 2026-10-30

- 点亮的「自动」按钮实时显示当前调度档位（订阅 modelSelection 会话投影 faceOf；
  `conversation.input.right` 插槽的 inject 回调 `(sessionId) => props` 拿会话 id）。
- 通道考古结论（asar 源码）：宿主→client 无任意事件转发（API_REMOTE_FORWARDED_EVENTS 封闭枚举），
  官方推荐通道 = session projection `wire.view`；modelSelection 投影 `pending`（手选意图）只在
  请求档位恰等于手选值时消化——自动调度下手选显示不消化属宿主语义，未改动。

## 0.1.5 — 2026-10-30

- 会话隔离的连续性保护：低档连续性保护（10 分钟窗口）现在只统计**同一会话**的工具调用。此前宿主进程里
  任意会话（例如几分钟前一个工具密集的会话）都会把新会话的闲聊消息（「你好」）经 minimax+continuity
  顶到 high。其它会话的 usage 行也不再被冲进请求会话的账本。



## 0.1.1 — 2026-10-30

### 修复
- **`auto` 泄漏导致 `UNSUPPORTED_REASONING_EFFORT`**：按钮熄灭（passthrough）时不再盲信快照里的
  `reasoningEffort`。任何不是 `low|high|max` 的值（`auto`、`medium`、空串、垃圾值）都会在发请求前
  被替换成「进入自动前的档位 → 当前手动档位 → `high`」，并记一条 warn：
  `effort "%s" is not accepted by the provider; sending "%s" instead`。
- **熄灭后还原**：从点亮切回熄灭的第一个请求会写回 `preAutoEffort`（进入自动前用户选的那档），
  之后按手动档位直通，不再把 `auto` 留在会话快照里。
- 按钮熄灭且不需要消毒时仍然 `return seed`（对象零改动），不做无意义的请求改写。

### 变更
- `npm test` 改为 `node --test test/`（原来的 `vitest run` 在没有 devDependency 的机器上跑不起来），
  并新增 `test:host` / `test:client` 两个单测入口。
- 新增 `tools/install.mjs`：把插件装进**指定** profile（默认拒绝 `desktop`），幂等、带备份、支持
  `--dry-run` / `--remove`。
- README 按 fork 的实际行为重写（原来还是上游 dsh-adaptive-effort 的说明）。

### 验证
- `node --test test/` → 13 passed（8 宿主 + 5 前端）。
- 安装脚本在临时 profile 上跑过 install → install（幂等）→ remove 全链路，
  `cordis.patch.yml` 与 `package.json` 都能回到原样；`desktop` profile 被正确拒绝。

## 0.1.0 — 2026-10-30

- 从 `dsh-adaptive-effort@0.3.0` fork 出来的初版：去掉「推理等级列表里的自动档」，改成输入栏的
  自动按钮（`conversation.input.model` 插槽，id `effort-auto-toggle-button`），点亮走调度、熄灭走人工；
  设置卡片与回复徽标一并继承。

