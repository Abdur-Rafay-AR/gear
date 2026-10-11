# 项目重构验证记录

基线：`origin/dev` 的 `9a1281dba7495ea454c637d1bbad4e1605f52db6`。2026-10-11 再次查询远端，dev 仍为此提交。实现分支 `codex/benchmark-refactor`；原工作区和所有 README 保持不变。

完整阶段与验收缺口见 [目标跟踪表](project-refactor-status.zh-CN.md)。

## 自动化证据

| 检查 | 结果与边界 |
| --- | --- |
| TypeScript 全量回归 | `697a63d` 的远端 CI：104 个测试文件通过、7 个按环境跳过；无模型环境项单独验证 |
| 项目定向回归 | archive 策略迁移后：10 个文件、101 项通过，含固定 fixture、真实 worker 协议闭环、bridge 恢复与 CLI 作者流程 |
| Python 全量回归 | archive 策略迁移后本地 335 项：331 项通过，4 项按环境跳过 |
| Python 公共 API | Ruff lint/format、Mypy strict 通过 |
| TS 质量 | typecheck、Biome、协议生成一致性、204 个模块依赖/循环检查通过 |
| CI/发布规则 | 14 项规则测试通过；dev 代码变更启用完整回归 |
| 独立 tgz/wheel | 六组 Target/模板组合；check/compile；共享应用 evaluate/refine/report/resume/export；SDK；无 GPU CPU loop 及恢复通过 |
| Python 真实 sandbox | macOS 实测拒绝工作目录之外的私有测试文件、宿主凭据环境变量和已监听的 loopback 端口 |
| Harbor verifier | 三种模板在真实 Docker 容器运行正反例；不安全软链接输出被拒绝；第四项验证输入附件的冻结内容、独立挂载和 inspect 一致性 |
| DSH 固定 carrier | rc.2 的有效 Skill 与完整 Harness 两组原生加载、prompt assembly、Skill 读取检查通过 |
| DSH/Pi 原生行为 | 发布用 runner 在真实 Docker 中各完成一次 Luna 调用；插件/extension 指定输出，经可信评分器得 1；运行后 inspect 一致 |

`697a63d` 的 [远端 CI](https://github.com/rsi-gear/gear/actions/runs/38116355997) 已全部通过：Quality 全量、真实容器 verifier、独立项目 tgz/wheel、外部搜索 API、Linux/macOS sandbox、CPU 训练及 Hitch 合同。该提交远端 Python 为 316 项（312 通过、4 跳过）；后续作者接口的本地验证单独记录如下，不把前次 CI 当作新代码验证。平台模型测试是显式启用项，不把跳过记为通过。未运行 GPU 训练，也未用自动化代替人工易用性测试。

`b1f147e` 的 [作者接口 CI](https://github.com/rsi-gear/gear/actions/runs/38118016443) 随后全部通过，含 Quality 全量、安装包检查、CPU、Linux/macOS sandbox 与真实 Hitch 合同；后续 Hitch 拆分及 OneShot 补证的本地结果分别记录，不把此 CI 当作后续提交验证。

`5af4b27` 的 [Hitch 拆分与 OneShot CI](https://github.com/rsi-gear/gear/actions/runs/38118585504) 已全部通过，包含 Quality、CPU、Linux/macOS sandbox 与 Hitch 合同。随后 archive 迁移的本地验证单独记录如下。

## 推送后修复

- `paired-pass-rate-v1` 修正最终 gate：先检查 seed 改善，再检查 held-out 不退步；拒绝的 seed 不触发 held-out 试验。32 项运行时测试通过，其中 16 组评分组合与历史 GEPA `decideFinal` 交叉比较，覆盖持平、退步、改善、预算和终态恢复。typecheck 通过。
- capabilities 拆分后，50 项经验、能力和轨迹回归通过，2 项真实日志测试按环境跳过；typecheck 和 202 模块边界/循环检查通过。
- 项目回归现为 5 个文件、50 项通过；新增算法请求的整组 seed 预算预检，预算不足时不开始部分评测，恢复继续复用原 decision 和 reservation。独立 tgz/wheel、六组模板、两种 Target 和 CPU loop 再次通过。发布测试对 Python 低于 3.10 的情况现在提前报告解释器要求。
- 报告现在按实际已提交的评测范围计算缺失数：seed gate 拒绝后，未安排的 held-out 不标为缺失；中断的部分 baseline 不显示完整 pass rate。
- 修正后的 gate 已完成两种 Target 的真实 Luna 复测：Pi 和 DSH 的 smoke 均 1/1，seed 都是 1 → 1，均以 `seed-not-improved` 保留原 champion，未运行 held-out。refine 新增物理评测分别为 0 和 1，两者终态 resume 一致。随后的 seed 预算预检和报告调整由上述定向回归覆盖。
- 下表保留首批实现的真实运行证据，使用当时冻结的 gate，与这次修复后的记录分开。

旧 GEPA 的槽位复用、返回值匹配和缺口核验现改为单次调用内的 Map/Set 索引，避免重复嵌套计算 SHA。保留全部摘要核验、来源验证和 1700 个候选 seed 槽位断言，未放宽原 90 秒上限。本地大规模测试通过，单次耗时由约 70 秒降至约 46 秒；这属于诊断测量，不是稳定性能基准。性能修复后的完整搜索回归共 21 个文件、307 项全部通过。随后远端全量测试通过，但 verifier 步骤遇到前序 root 测试留下的 Vite 缓存权限错误；`140c5da` 让两个 Vitest 步骤使用同一服务用户后，整条 CI 已通过。新的源码身份由现有机制生成，旧 run 仍使用其冻结 runtime。

## Python scope 采样迁移

新增公开 `ScopeSampler` 以及 `create_scope` / `resolve_sizing` 和类型化输入。`test-contracts/gepa-scopes-v1.json` 的 10 组期望值来自未修改的旧 TypeScript 采样实现（源提交 `140c5da`），覆盖成功对照、难度/成本分层、模块与子模式覆盖、共享范围、跨题族与 fallback、epoch、Unicode、guard-only 零权重、空失败族、配额和容量不足。TypeScript 和 Python 各自比较固定输出，不由 Python 自己生成期望值。

本地验证：项目合同 61 项通过；新增 Python 8 项及已有公共 API 7 项通过；Ruff lint/format、Mypy strict、typecheck、Biome、边界与协议检查通过。独立 tgz/wheel 的六组模板、两种 Target、CPU loop/恢复、SDK 检查通过，并新增从安装后的 wheel 运行 `GEPA(task_sampler=ScopeSampler())`。本次为纯离线策略迁移，没有新增模型测试。

默认 recipe 未切换，`ScopeSampler` 只消费选题结果。后续加权局部阶段及 bridge 见下一节；动态 scope 生命周期、历史难度证据构建和通用 objective 仍待完整迁移。fixture 不比较或重写历史身份；此结果不代表整个历史 GEPA 等价。

## Python frontier / bridge 与分阶段 recipe

公开 `scope_frontier` 迁入逐题前沿、相同 Target 代表、联合冗余删除、outcome/process 概率混合、pending 与 guard 拒绝分类；`select_bridge` 迁入题族轮换、并集容量、分层补充、整组预算报价和排除原因。`test-contracts/gepa-stages-v1.json` 固定了旧实现（源提交 `53f30ad`）的 10 组 frontier 和 10 组 bridge 输出；输入包括已验证 profile 比较键和显式冻结的 locale 顺序，不把 Python 的默认排序当成旧 locale 排序。

可选 `StagedGEPA` 在公开 Python 合同内运行：完整 seed 前沿父代 → 按题族生成 → 局部加权提名 → 同范围 bridge → global seed → runtime 最终 gate。它预检整组开销、保留后续扩展预算、按终态 receipt 消耗无效生成额度，拒绝把不完整 bridge 当作可比排名。新状态标识 `staged-gepa-v1` 与旧 recipe 隔离；默认 `algorithm: gepa` 未切换。当前适配器是 pass-rate 流程，不宣称完整多 scope archive、process/objective、adaptive scopes 或 regression proposals 迁移完成。

验证结果：84 项项目合同通过；Python 全量 316 项中 312 通过、4 跳过；Ruff lint/format、Mypy strict、typecheck、Biome、202 模块边界及协议检查通过。真实 Python worker 经 TypeScript runtime 完成 local/bridge/global/held-out 离线闭环；另在 bridge provider 已返回结果后模拟断线，以新 runtime 对象恢复，原 decision 不变、生成和物理提交均无重复。独立 tgz/wheel 检查新增安装后的 `StagedGEPA` toy round，六组模板、两种 Target、CPU loop 与 SDK 仍通过；真实 macOS worker sandbox 检查再次通过。本轮没有新增模型测试。

为重复 Target 选择传递可选只读 `Candidate.content_digest`，不向 Python 暴露源码或 held-out。同时修正 CPU toy 执行器：已有有效零分原样复用，重复请求不覆盖观察或扣减预算；独立回归已覆盖。没有修改历史身份、数据或 run 日志。

## Python 作者 SDK 与离线合同入口

已补齐 `Project.open`、九个异步方法、`refine(algorithm=...)` 与双 CLI `algorithm test`。算法对象封存为普通 Python 源码，哈希目录保留旧版本；闭包、非构造状态和符号链接被拒绝，复杂构造可显式提供 `AlgorithmSource`。单次覆盖只进入 run binding，不修改 gear.yaml。取消异步客户端会回收本地 CLI，外部操作仍遵循显式 cancel/resume 和原有预留记录。

14 项 Python 作者测试验证本地依赖封存、直接脚本/包导入、源码变更、篡改拒绝、嵌套配置、输入不可变、重放一致、完整 seed 提名、非阻塞调用与取消回收。3 项新 TypeScript 测试验证 CLI 转发、参数合同、可读结果、冻结运行配置与终态恢复。全量 Python 330 项中 326 通过、4 跳过；项目 87 项通过；Ruff、23 个公共模块的 Mypy strict、typecheck、Biome、203 模块边界及协议检查通过。

真实 macOS sandbox 两项通过：既有凭据/文件/网络隔离，及 SDK 封存策略的实际执行。修改原作者文件后仍使用冻结策略，修改已封存文件后拒绝执行。独立 tgz/wheel 检查通过，新增从安装包运行单文件父代、GEPA factory 和独立 `OneShot` 算法；Python 与 Node CLI 决策摘要一致；同步/异步 SDK 和源码封存均通过。此轮没有新增模型调用。完整历史 GEPA 等价、迁移与人工验收仍未完成。

独立 `OneShot` 示例随后经真实 Python 协议进程完成 durable runtime 回合：baseline → 一次生成 → 10 题完整 seed → 2 题 held-out gate → champion 更新。它没有继承或调用 GEPA；计划不包含 diagnose/local/bridge。终态 resume 不增加物理提交或候选生成。新增测试与原有两项 StagedGEPA 闭环/恢复测试共 3 项通过，typecheck 通过；安装后 toy 的证据保留在上一段。此项为离线 fixture provider 合同，不是额外模型实验。

## 多 scope archive 与父代分配

`test-contracts/gepa-archive-v1.json` 的 11 组 archive 与 55 份父代分配计划由源提交 `5af4b27` 的旧 TypeScript 实现生成；没有修改旧 archive、frontier 或 parent policy。固定样例覆盖 bootstrap、多题族均匀混合、等价 scope 去重、新 epoch 未就绪时回退、旧 epoch 替换、guard 拒绝、缺失 process 与后续补齐、相同 Target 内容、champion 固定引用以及冻结的旧 locale 排序。双语言分别比较同一固定输入/输出，不由 Python 生成期望值。

Python 新增 seed-only archive 投影、`ParentInput` / `ParentPlan`、无可变游标的 `RandomSource` 和 scoped/champion 混合策略。原 `FrontierParentPolicy` 复用新投影，frontier 实现移至单独模块并保留原 imports；移除重复随机实现。候选实例身份与内容身份分开；可信 profile 冲突、scope/候选越界与非法配额被拒绝。投影不持久化原始 observations，不接管 runtime 的证据认证或修订。周期性 epoch 准备、adaptive scope 与完整历史 archive 生命周期尚未完成。

新增 5 项 Python 测试验证固定比较、重放/输入不变、身份/证据冲突拒绝、配额合同与局部完整证据；局部缺失评分不再隐式按零分判为失败。公开 `archive_policy.py` 用题族 archive 选择父代，通过真实 Python 协议 worker 接入 durable runtime：两次生成、完整 seed、独立 held-out gate 和终态恢复，不重复提交。

本地项目 101 项通过，Python 全量 335 项中 331 通过、4 跳过；Ruff lint/format、28 个公共模块 Mypy strict、typecheck、Biome、204 模块边界和协议生成检查通过。macOS 实际 worker sandbox 两项通过。独立 tgz/wheel 安装检查通过，新增从安装包用两种 CLI 检查 archive 策略及 factory；六组模板/Target、SDK、CPU training 和恢复继续通过。本轮没有新增模型调用，没有修改 README、历史身份或原用户工作区。

## Hitch 执行合同拆分

将执行策略、请求 admission、幂等键、执行条件摘要、daemon submission 核验和完整 trial 槽位校验移入 `adapters/hitch/execution-contract.ts`，移除 evaluator 中的原实现。evaluator 从 1609 行降至 1323 行，继续负责 IO、提交、取消和恢复；合同模块不拥有副作用或运行状态。完整槽位检查保留在一个函数中，以同一冻结 plan 校验身份、attempt 范围、重复与缺失，未为行数拆散该不变量。

拆分前从 `b1f147e` 的正式构建冻结了三组执行条件固定值（`test-contracts/hitch-execution-v1.json`），覆盖 direct 默认值、daemon capture、资源和输出上限；新模块的参数、幂等键、条件摘要与调用指纹保持一致。组件实现摘要正常更新为新源码闭包，新模块本身纳入摘要；历史 fixture、身份规则和数据未修改。源码版与正式构建身份一致，修改新模块只改变 Hitch 组件身份，相关篡改测试通过。

定向 evaluator/identity 合同共 127 项：初次执行有 1 项当前实现摘要快照因预期源码变化失败；确认构建版与源码版均生成同一新摘要后，更新当前快照并复验该文件 7 项全部通过，其余 120 项在首轮通过。typecheck、Biome、204 模块依赖检查通过；独立搜索包合同、tgz/wheel 项目旅程均通过。没有替换或重算历史数据中的身份。剩余执行层拆分仍见目标跟踪表。

## Luna 项目闭环

使用 `gpt-5.6-luna`，固定 DSH `0.1.1-rc.2`、Pi `0.68.0`；同一份任务表（一题 seed 加法、一题 held-out 大写转换），相同 Python recipe。真实路径为 init → check → 单题 evaluate → refine → report → resume。模型由本机已有 DSH 凭据存储授权；凭据不保存到此记录、候选或项目配置。

| Target | smoke | refine 新增物理任务尝试 | 复用的观察槽位 | 最终 gate | 终态 resume |
| --- | --- | --- | --- | --- | --- |
| Pi | 1/1 | 1 | 3（baseline、相同候选 seed、相同候选 held-out） | 1 → 1，保留原 champion | 一致 |
| DSH | 1/1 | 3 | 1（smoke 的 baseline） | 1 → 1，保留原 champion | 一致 |

Pi Meta 返回了相同文件，因此相同代码/题目/重复槽位使用同一观察，不再次采样挑选结果。DSH Meta 生成了不同文件，在 seed 与 held-out 均持平。以上证明执行、隔离、计量和恢复路径，没有证明泛化收益。

## 迁移范围

已交付：可读 CLI 与 JSON/SDK/Skill 路由、CSV/JSONL 与输入附件导入、版本化文本/JSON/文件模板、Python 策略和完整算法入口、受 sandbox 约束的 worker、统一 gear.training 与兼容转发、DSH/Pi mutation policy、Git Target 快照、操作预留与恢复、证据复用、Meta 报告隔离、固定 native runner、独立发布包验证和 CI 门禁。DSH 与独立 Skill 的组件装配已共用；旧存储的历史格式校验抽到 compat，持久化 IO 保持独立。旧 service 的 baseline、证据投影、生成状态、修复和提交状态已拆出；Hitch 的 transport 与结果/轨迹/verifier 解码按职责拆分，并纳入实现身份。

仍属于后续迁移/验收：历史 failure-cluster GEPA 的 adaptive scopes、archive/bridge、regression proposals 与通用 objective 尚未全部迁入 Python；旧 service/evaluator/capabilities 的其余实现继续保留；任意 Harbor verifier 的直接导入仍走原入口；设计规范 U1 的五人易用性测试尚未开展。因此本分支不能被描述为规范 M0–M5 全部验收完成。详见 [迁移边界](project-migration.zh-CN.md)。

## 复现入口

- `npm run test:project`：离线项目合同。
- `npm run test:project:package`：独立安装与 CPU 训练恢复。
- `GEAR_TEST_PROJECT_SANDBOX=required GEAR_TRAINING_TEST_PYTHON=/absolute/python npx vitest run tests/integration/project-worker-sandbox.spec.ts`：实际 OS 隔离。
- `GEAR_VERIFIER_TEST_IMAGE=python:3.12-slim npx vitest run tests/integration/project-verifier.spec.ts`：无模型真实 verifier。
- 先按 CONTRIBUTING 设置镜像与凭据引用，再执行 `npx vitest run tests/integration/project-native.spec.ts`：两项计费模型行为测试。

运行日志仅在本机临时验证目录保存；文档只保存非秘密结果与可复现命令。
