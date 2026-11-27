# agy-codex — Antigravity 指挥 Codex 工作调度系统

本仓库提供了一套零外部依赖的 **Node.js 调度程序 + Antigravity 技能/规范**，用于让 Antigravity 作为“指挥官（Commander）”向本机 Windows 上的 OpenAI Codex CLI 下达结构化任务指令、自动识别并打回 **Codex 的回避型回复**、自动验收 `git diff` 与测试命令、支持会话续跑（`resume`）以及基于 `git worktree` 的多任务并行派发。

---

## 目录结构

```text
agy-codex/
├── .agents/skills/codex-commander/SKILL.md  # Antigravity 自动发现的指挥 SOP 技能
├── AGENTS.md                                # 仓库级指挥官行为规范
├── bin/agy-codex.mjs                        # 主命令行入口
├── config/agy-codex.config.json             # Codex 路径、沙箱、重试与反回避阈值配置
├── src/
│   ├── config.mjs                           # 配置加载与 Windows Codex CLI 自动探测
│   ├── prompt-builder.mjs                   # 结构化指令编译 + 逐级加压的打回纠偏词
│   ├── evasion-detector.mjs                 # 核心：回避型回复多信号审计引擎
│   ├── codex-runner.mjs                     # codex exec / resume 执行器（stdin 传参 + mock 模式）
│   ├── verifier.mjs                         # 基线对比、git diff 收集与验证命令执行
│   ├── worktree.mjs                         # git worktree 隔离分支创建与清理
│   ├── store.mjs                            # 运行产物持久化与 Commander Review 报告生成
│   ├── orchestrator.mjs                     # 派发 -> 验收 -> 反回避打回 -> 续跑 状态机
│   └── queue.mjs                            # 多任务串行/并行调度队列
├── templates/                               # 单任务与并行队列模板
└── test/                                    # 自动化单元测试与端到端测试
```

---

## 核心能力：反回避型回复引擎（Anti-Evasion）

当 Codex 收到任务后出现敷衍、推诿或“只说不做”时，`src/evasion-detector.mjs` 会结合 **文本特征 + 实际工作区文件变动 + Diff 扫描 + 验证命令结果** 进行综合评分与拦截：

| 回避类型 | 典型表现 | 处理动作 |
| :--- | :--- | :--- |
| `clarification_deflection` | 反问“你希望我怎么做？”“开始前请确认…” | 阻断并自动 `resume`：要求自主做合理工程决策并直接落地 |
| `advice_only_deflection` | 只输出“你可以修改 xxx / 建议步骤”，不改代码 | 阻断并自动 `resume`：禁止口头教程，强制直接编辑文件 |
| `zero_diff_claim` | 任务要求改代码但工作区 0 文件变动，且无硬阻塞证据 | 阻断并自动 `resume`：强制产出实际代码变更 |
| `deferred_work` / `diff_placeholders` | “为简洁起见省略”“其余部分同理”、Diff 中新增 `TODO`/`FIXME`/桩函数 | 阻断或告警并打回补全 100% 实现 |
| `unverified_claim` | “应该可以工作”“未运行测试”或验收命令失败 | 自动打回并要求修复直至验收命令退出码为 0 |
| `premature_surrender` | “请手动执行”“当前环境无法运行”且无真实报错证据 | 阻断并要求直接执行，或提供真实 `BLOCKER_EVIDENCE` |
| `missing_receipt` | 忽略指挥官要求的结构化 `## EXECUTION_RECEIPT` 回执 | 扣分告警，督促按协议汇报 |

每次拦截都会基于**同一 Codex 会话（`codex exec resume <session_id>`）**发送逐级升级的纠偏指令（`FIRM_CORRECTION` -> `FINAL_ZERO_TOLERANCE`），超过最大尝试次数后自动标记为 `evasion_escalated` 并生成 `review.md` 交由 Antigravity 指挥官接管。

---

## 快速开始

### 1. 安装与环境体检
```powershell
git clone https://github.com/<YOUR_GITHUB_USERNAME>/agy-codex.git
cd agy-codex
npm run doctor
```
若未检测到 `codex`，请安装 OpenAI Codex CLI（`npm install -g @openai/codex`），或在环境变量 `CODEX_BIN` / `config/agy-codex.config.json` 的 `codex.bin` 中指定路径（如 `<YOUR_CODEX_BIN_PATH>`）。

如需打包为独立 npm 安装包（`.tgz`）：
```powershell
npm run pack:pkg
# 全局安装打包产物：
npm install -g ./agy-codex-1.0.0.tgz
```

### 2. 离线演示（Mock 模式验证反回避自动打回闭环）
```powershell
npm test
```

### 3. 创建并派发单任务
```powershell
node bin/agy-codex.mjs init-task --out tasks/fix-auth.json --id fix-auth --title "修复登录令牌刷新"
node bin/agy-codex.mjs dispatch --task tasks/fix-auth.json
```
或直接通过命令行参数临时派发：
```powershell
node bin/agy-codex.mjs dispatch --title "修复解析器" --objective "修复空行解析异常并补充单测" --cwd <YOUR_REPO_PATH> --target src/parser.mjs --verify "npm test"
```

### 4. 查看审查报告 & 手动打回续跑
```powershell
node bin/agy-codex.mjs status
node bin/agy-codex.mjs review --run <run-id>
node bin/agy-codex.mjs resume --run <run-id> --note "不要再给建议，直接补齐边界用例并确保 npm test 通过。"
```

### 5. 多任务并行派发（Git Worktree 隔离）
```powershell
node bin/agy-codex.mjs queue --file templates/task.queue.json --concurrency 2 --worktree
# 审查合并分支后清理 worktree：
node bin/agy-codex.mjs cleanup-worktree --run <run-id> --delete-branch
```

---

## 运行产物结构

每次派发会在 `runs/<run-id>/` 下保存完整审计档案：
- `task.json` — 标准化任务单
- `attempt-N/prompt.md` — 第 N 次下发的指挥指令或打回纠偏指令
- `attempt-N/events.jsonl` — Codex `--json` 原始事件流
- `attempt-N/last-message.md` — Codex 最终回复
- `attempt-N/evasion.json` — 反回避审计明细
- `attempt-N/verify.json` — 文件变动与验证命令结果
- `diff.patch` — 最新代码差异补丁
- `summary.json` — 结构化运行汇总
- `review.md` — 供 Antigravity 与用户查阅的指挥官审查报告
