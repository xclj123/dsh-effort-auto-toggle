# dsh-effort-auto-toggle

DeepSeek Harness（DSH）桌面版的推理档位自动调度插件：在输入栏模型选择器旁边加一枚
「自动」按钮——点亮后，每条请求的 `reasoning_effort` 由插件按消息复杂度自动选择；
熄灭后回到原生手动选档，模型弹窗的推理等级列表保持原样（不注入任何伪档位）。

![screenshot](docs/screenshot.jpg)

本项目是 `dsh-adaptive-effort` 的 fork。上游在推理等级下拉框里注入
一个「自动」档位，模型切走或快照残留时会把它原样发给服务端，触发
`UNSUPPORTED_REASONING_EFFORT` 报错；本 fork 把「自动」从档位列表挪到独立按钮，
并在 passthrough 路径上消毒一切非真实档位，从根上消灭该错误。

## 特性

- **按钮开关**：点亮 = 自动调度；熄灭 = 原生手动档位，熄灭瞬间还原你进入自动前的选择。
- **模型自适应档位**（0.2.0+）：不写死 `low/high/max`。每次请求向宿主 `llm` 服务查询当前
  模型的真实档位表（glm-5.3 是 `low/high/max`，别的 adapter 可能是
  `low/high/highx/max/ultra`……），调度器内部三档语义映射上去：
  轻 → 最轻档、重 → 最重档、中 → 约 2/3 处（3 档→第 2 档，5 档→第 3 档）。
- **复杂度打分**：MiniMax / 任何 OpenAI 兼容端点的小模型（打分时关闭思考，快且便宜）给
  最近一条用户消息打分；无 key / 超时 / 网络不可用时回退零依赖启发式（关键词 + 长度 +
  代码块）。**打分失败会进 60 秒负缓存**（0.3.4）：冷却期内直接用启发式，不再每一步都
  白等一次 timeout，冷却过后自动重试打分模型。打分器的判定是权威的，
  启发式只在出现明确重关键词堆叠（分数 ≥ 70）时才推翻低档判定（0.3.3）。
- **工具负载分级升级**（会话隔离）：同会话 10 分钟内的工具调用按参数体积买档位——
  ≥ 800 字符升一档、≥ 3200 字符升两档，封顶在最重档（0.3.4）。原来 800–3199 是死区，
  3000 字符的 `apply_patch` 和一条 `ls` 待遇完全一样；现在一条 `ls` 不抬档、
  中等补丁升一档、大补丁升两档。手选档位永远不升级。
- **手动优先**：模型选择器里手选的档位永远原样透传（含各模型独有档名如 `ultra`）。
- **GLM-5.3 安全**：强制思考模型上手动 `off` 会被钳到最轻档，而不是等 API 报错。
- **实时显示**：点亮时按钮直接带档位原文（`自动·low` / `自动·highx`），消息角标同步
  （`glm-5.3 · low`），档名就是 adapter 自己的英文命名。
- **账本**：每次调度决策 + 实际 token 用量记 JSONL（`~/.dsh/effort-auto-toggle/`），
  附带 markdown 汇总报告。

## 前置要求

- DeepSeek Harness 桌面版（在 2026-10 的宿主上验证；依赖点见下方「兼容性」）
- Node.js ≥ 20（跑安装脚本与测试用；DSH 自带的 node 也行）

打分模型**可选**：不配 key 时用 `--mode heuristic` 安装，纯启发式也能工作，
只是没有小模型打分那么准。

## 安装

```bash
git clone <repo-url>
cd dsh-effort-auto-toggle

# 看看本机有哪些 profile（不给 --profile 时会自动列出）
node tools/install.mjs

# 装进一个测试 profile（推荐先用非 live profile 试）
node tools/install.mjs --profile "<profile 目录>"

# 带打分模型安装（任何 OpenAI 兼容 chat 端点）
node tools/install.mjs --profile "<profile 目录>"   --mode minimax --minimax-key <你的key>   --minimax-url https://open.bigmodel.cn/api/coding/paas/v4   --minimax-model glm-5.3-flash

# 直播 profile 需要显式 --force（脚本默认拒绝 desktop，防误伤）
node tools/install.mjs --profile "<…>/profiles/desktop" --force <其余参数同上>
```

装完**重启 DSH**。安装脚本幂等（重复跑只更新），改写 `package.json` /
`cordis.patch.yml` 前都会留 `.bak-<时间戳>` 备份；`--dry-run` 可预览。

**Windows / macOS / Linux 通用**：profile 自动探测 `~/.dsh/profiles/`，路径全部走
`os.homedir()` + `path.join`。

## 配置

> 首次点亮「自动」且尚未配置打分 key 时，输入框上方会弹出引导卡：可直接粘贴 key 保存（写入插件配置）、一键切换启发式，或关闭不再提示。

安装时写进 profile 的 `cordis.patch.yml`，之后**设置卡上直接改**（无需重启）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `autoOn` | `false` | 按钮当前状态（点亮=true） |
| `mode` | `minimax` | `minimax`（小模型打分）/ `heuristic`（纯启发式） |
| `minimaxApiKey` | — | 打分端点 key |
| `minimaxBaseUrl` | — | OpenAI 兼容 chat 端点 |
| `minimaxModel` | — | 打分模型名（选便宜快的） |
| `allowToolUpgrade` | `true` | 工具连续性升档开关 |

仅 yaml 可改：`scoreTimeoutMs`（默认 9000ms，超时回退启发式）、`clampForcedThinkingOff`（默认
`true`）、`ledgerDir`（默认 `~/.dsh/effort-auto-toggle`）。

## 使用

1. 重启 DSH 后，输入栏模型选择器左侧出现「自动」按钮（熄灭状态）。
2. 点亮 → 从下一条消息起自动调度；按钮随实际请求跳动显示档位
   （`自动·low` → `自动·high` → …）。
3. 再点熄灭 → 还原你进入自动前手选的档位，一切回到原生行为。
4. 每条回复下方角标显示该请求实际用的档位。

## 账本与报告

```bash
node lib/report.js <sessionId前缀>     # 汇总某会话的调度与 token 报告
```

JSONL 每行一个事件：调度决策（语义 tier / 实际 effort / 理由 / 打分来源 / 分数）与
usage 回填（output token、未缓存 input token、prompt cache 读/写）。

报表分两张表：**实际档位**（按真正跑过的 effort 动态分桶，单档模型只有 `high`、
五档模型会有 `highx`/`ultra`，从轻到重排序）与**分类器判定**（按语义 tier 分桶）。
两者会不一致——那正是重点：语义 `low` 在只有一档的模型上必然执行成 `high`。

## 卸载

```bash
node tools/install.mjs --profile "<profile 目录>" --remove
```

恢复 `package.json` / `cordis.patch.yml` 原样并删除插件文件，重启 DSH 生效。

## 测试

```bash
npm test          # 21 个用例，零依赖（node --test），无需 npm install
```

覆盖：passthrough 消毒、手动优先、点亮调度全链路（5 档模型端到端）、连续性升档、
会话隔离、ladder 纯函数、按钮档位显示（含无 sessions 服务的降级）。

## 与 dsh-adaptive-effort 的差异

| | adaptive-effort（上游） | 本 fork |
|---|---|---|
| 自动入口 | 档位下拉框注入「自动」档 | 独立按钮，档位列表不动 |
| `auto` 泄漏 | 可能（切模型/快照残留 → API 报错） | passthrough 全消毒 |
| 档位表 | 写死 low/high/max | 跟随模型真实档位表（0.2.0+） |
| 档位显示 | 中文 | adapter 原文（英文） |
| 打分回退缓存 | 回退结果被缓存，整回合卡启发式 | 回退不缓存，下条消息重试 |
| 连续性保护 | 跨会话泄漏 | 会话隔离（0.1.5+） |
| 宿主 settings | 旧 `register()` API（新宿主上静默死亡） | 现代 describe/update（0.1.2+） |

## 兼容性

宿主依赖点（0.3.5 已在 DSH **0.2.2-rc.3** 与 **0.2.2-rc.5** 的 asar 源码里各复核一遍，两版一致）：

**兼容 DSH 0.2.1 到 0.2.2-rc.5**：插件运行时自动探测宿主能力——旧宿主继续走
`agent/request` 改写路径，新宿主（effort 改走 `agent.model.select()`，`agent/request`
只读校验）自动切换到 claim-time 决策路径，无需分别安装。

- `session/event`（**账本主写入路径**：宿主一报告 usage 就落账，0.3.4 起不再依赖
  `agent/request` 才能记账）
- `agent/request` waterfall（prepend 注册；0.2.2+ 宿主上只读，仅用于取 payload 与补扫
  ——上游标了 `@deprecated`「do not add new listeners」，所以只保留兜底用途）
- `agent/inbox/claimed` 广播（0.2.2+ 宿主的 claim-time 决策窗口）与 `agent.model.select()` API
- `Session` 事件读取：0.2.2-rc.3 移除了 `Session.events`，0.3.3 起按
  `snapshotEvents()` → `ownEvents()` → `eventAt()`/`seq` → `events` 四级探测（前三者在
  rc.3 标了 `@deprecated` 但仍可用；四级的目的是兼容老宿主与未来再变）
- `llm` 服务 `resolveModelInfo(provider, model)`（0.2.0 档位表来源）。返回里**没有
  `reasoning` 字段**= 该路由没有档位，0.3.5 起记成空档位表并永不调度（0.3.4 之前会冒充
  默认三档下发，撞上适配器的 `UNSUPPORTED_REASONING_EFFORT`）；`INVALID_MODEL_REASONING`
  同样按"无档位"处理，其他错误（传输、未知模型）不缓存、下次重试
- `settings` 服务现代 `describe` / `update`（ns = profile entry id；`ctx.fiber.entry` 在
  rc.5 可用，插件仍优先用它、失败再兜底 entry id）。**热路径不再调 `describe()`**：装配时
  拿到的 volatile 字段是真·活引用（`{get()}`），每次直接读，0.3.5 起每个请求省一次
  `describe` 全量枚举
- client 侧 `conversation.input.right` 插槽、`modelSelection` 会话投影、
  `configForms`、`sessions` 服务（嵌套 `ctx.inject` 捕获）
- client 注入包名：`dsh-client-ui-renderer` / `dsh-client-locale` /
  `dsh-client-ui-settings` / `dsh-api-remotes`（rc.3 中实际提供 `slots` / `locale` /
  `configForms` / `remote.settings` 的四个包）

宿主更新若改动这些锚点，本插件需要跟进；欢迎提 issue。

## License

MIT
