# 项目重构验证记录

基线：`origin/dev` 的 `9a1281dba7495ea454c637d1bbad4e1605f52db6`。2026-10-11 再次查询远端，dev 仍为此提交。实现分支 `codex/benchmark-refactor`；原工作区和所有 README 保持不变。

完整阶段与验收缺口见 [目标跟踪表](project-refactor-status.zh-CN.md)。

## 自动化证据

| 检查 | 结果与边界 |
| --- | --- |
| TypeScript 全量回归 | `697a63d` 的远端 CI：104 个测试文件通过、7 个按环境跳过；无模型环境项单独验证 |
| 项目定向回归 | 工作计划执行接入后：16 个文件、262 项通过，含跨语言结构正反例、诊断计量/认证/恢复、修改边界、固定 GEPA fixture、真实 worker 闭环与恢复、作者 CLI |
| Python 全量回归 | 工作计划阶段接入后本地 371 项：367 项通过，4 项按环境跳过 |
| Python 公共 API | Ruff lint/format、Mypy strict 通过 |
| TS 质量 | typecheck、Biome、协议生成一致性、211 个模块依赖/循环检查通过 |
| CI/发布规则 | 14 项规则测试通过；dev 代码变更启用完整回归 |
| 独立 tgz/wheel | 六组 Target/模板组合；check/compile；共享应用 evaluate/refine/report/resume/export；独立诊断、安装后 StagedGEPA 工作计划与终态恢复；SDK；无 GPU CPU loop 及恢复通过 |
| Python 真实 sandbox | macOS 实测拒绝工作目录之外的私有测试文件、宿主凭据环境变量和已监听的 loopback 端口 |
| Harbor verifier | 三种模板在真实 Docker 容器运行正反例；不安全软链接输出被拒绝；第四项验证输入附件的冻结内容、独立挂载和 inspect 一致性 |
| DSH 固定 carrier | rc.2 的有效 Skill 与完整 Harness 两组原生加载、prompt assembly、Skill 读取检查通过 |
| DSH/Pi 原生行为 | 发布用 runner 在真实 Docker 中各完成一次 Luna 调用；插件/extension 指定输出，经可信评分器得 1；运行后 inspect 一致 |

`697a63d` 的 [远端 CI](https://github.com/rsi-gear/gear/actions/runs/38116355997) 已全部通过：Quality 全量、真实容器 verifier、独立项目 tgz/wheel、外部搜索 API、Linux/macOS sandbox、CPU 训练及 Hitch 合同。该提交远端 Python 为 316 项（312 通过、4 跳过）；后续作者接口的本地验证单独记录如下，不把前次 CI 当作新代码验证。平台模型测试是显式启用项，不把跳过记为通过。未运行 GPU 训练，也未用自动化代替人工易用性测试。

`b1f147e` 的 [作者接口 CI](https://github.com/rsi-gear/gear/actions/runs/38118016443) 随后全部通过，含 Quality 全量、安装包检查、CPU、Linux/macOS sandbox 与真实 Hitch 合同；后续 Hitch 拆分及 OneShot 补证的本地结果分别记录，不把此 CI 当作后续提交验证。

`5af4b27` 的 [Hitch 拆分与 OneShot CI](https://github.com/rsi-gear/gear/actions/runs/38118585504) 已全部通过，包含 Quality、CPU、Linux/macOS sandbox 与 Hitch 合同。随后 archive 迁移的本地验证单独记录如下。

`ea7b02e` 的 [archive 与父代策略 CI](https://github.com/rsi-gear/gear/actions/runs/38119768715) 已全部通过，包含 Quality、CPU、Linux/macOS sandbox 与 Hitch 合同。下面的 epoch 集成属于其后新增代码，不用该 CI 代替新代码验证。

`420c6f2` 的 [epoch 生命周期 CI](https://github.com/rsi-gear/gear/actions/runs/38120986517) 已全部通过，包含 Quality、CPU、Linux/macOS sandbox 与 Hitch 合同。以下历史采样投影有独立的本地验证，不把旧 CI 视为新增代码的验证。

`a306123` 的 [历史采样 CI](https://github.com/rsi-gear/gear/actions/runs/38122255845) 已全部通过，包含 Quality、CPU、Linux/macOS sandbox 与 Hitch 合同。多父代阶段的验证另记如下。

`c17efd2` 的 [多父代阶段 CI](https://github.com/rsi-gear/gear/actions/runs/38123146789) 已全部通过，包含 Quality、CPU、Linux/macOS sandbox 与 Hitch 合同。下述诊断与提案策略有独立本地记录，不将该 CI 算作新提交验证。

`c88f2f5` 的 [诊断策略及引用绑定 CI](https://github.com/rsi-gear/gear/actions/runs/38124628907) 已全部通过，包含 Quality、CPU、Linux/macOS sandbox 与 Hitch 合同。以下 payload schema 属于后续新改动，验证单独记录。

`f3efe44` 的 [完整 payload schema CI](https://github.com/rsi-gear/gear/actions/runs/38125680393) 已全部通过，包含 Quality、CPU、Linux/macOS sandbox 与 Hitch 合同。独立诊断端口属于后续新增代码，验证如下。

`4645fef` 的 [独立诊断账本 CI](https://github.com/rsi-gear/gear/actions/runs/38127378206) 已全部通过，包含 Quality、CPU、Linux/macOS sandbox 与 Hitch 合同。工作计划实际执行的新改动另列如下。

## 诊断后的工作计划与实际修改边界

StagedGEPA v4 在启用模型诊断时分开提交诊断和生成，`stage_proposals.py` 从当前阶段的新回执选择有支持证据的假设，冻结工作计划并绑定诊断 ID。父代/题族/假设跨批去重，未使用配额保留排除理由，不重分配。诊断预算用尽仍能完成已支持候选的后续阶段；未解析事实不能授权生成。因果题族可不同于数据分层，复用原任务/权重并登记新的 scope 身份；旧 v3 状态明确拒绝，须用其原 runtime。

运行层在提交 decision 前核对工作计划的父代、dossier、假设、完整 seed manifest、目标任务、引用和修改路径。按分配范围摘录 seed 文本和诊断事实，将完整交付与身份保存到生成 reservation；恢复 inspect 原生成，不重新挑选诊断或计划。新增、编辑和删除均先过 Target 验证，再核对认证路径；越界保留生成成本与来源，记录 `workplan-boundary`，不封存候选。生成输入及返回文件已解除共享对象引用。

21 项执行回归通过，包含真实 Python StagedGEPA 的诊断/工作计划/local/最终 gate/终态恢复、生成响应丢失后恢复、范围内文本与事实投影、返回文件隔离、五种越界/输入篡改、十二种伪造或未支持限制、无支持假设时保留研究记录。Python 另有四项多父代工作计划测试，覆盖预算用尽、配额去重、不支持事实、旧状态/陈旧回执/错误父代拒绝和生成 wire 合同。

协议新增 `generation_workplan: certified-boundary-v1`，schema 生成完整 workplan 与 GenerationBudget 字段；原 51 组 wire 样例不变，新增 12 组，现为 63 组。公开 Python dataclass 字段覆盖检查也包含这两个结构。旧历史 GEPA 固定样例未修改，不用新阶段输出作为历史等价证明。

项目回归 262 项全部通过；Python 全量 371 项中 367 通过、4 跳过。Ruff（43 文件）、Mypy strict（39 文件）、typecheck、Biome、211 模块边界及协议生成检查通过；macOS 实际 worker sandbox 两项通过。安装后的 tgz/wheel 在 DSH/Pi 布局各运行一次独立 Python 进程的 StagedGEPA，检查工作计划、诊断用量、最终 gate 和恢复；原六组模板、SDK、作者 CLI、源码封存和 CPU training 继续通过。发布探针的嵌入脚本先发现换行转义错误，修正后重跑通过；一次未指定解释器的调用被 Python 版本预检拒绝，未计为成功。

边界：工作计划执行当前不接受任何显式 deadline/token/request 限制，均在生成预留前拒绝；None 只表示没有声明该限制。交付身份采用新项目传输格式，不冒用旧纯策略 delivery 身份或作为模型已读凭证。真实消费/阅读审计、原生诊断与生成请求前硬限制及可信用量仍待接入。没有新增 Luna 调用，未改 README、历史身份或原工作区；M3 仍未完成。

## 独立诊断端口、计量与 seed 来源认证

新增可选 `DiagnosisProvider` 和显式 `budget.diagnosis`，按冻结端口身份准入，在调用前写入请求/input/output token 预留。实际用量先持久化再校验事实，坏事实与超额输出保留成本；未知提交只 inspect，不重发。仅明确的 `not-started` 允许使用原冻结输入继续提交。诊断取消走独立端口，未核实的预留不会退还。批次预检在提交 decision 前完成，各次调用按尚待执行数量分配剩余 token。

回执只引用同父代的 seed 评分日志，拒绝越界任务/引用、成功冒充失败、失败冒充成功、有效观察被标无效和非法修改路径；省略事实填为未解析或有依据的状态。证据引用绑定原任务/scorer/trial/父代，端口收到有界 seed 文本和不透明引用，不接收 held-out 或 scorer 答案。公开 dossier 不复制原始输出，实际运行层生成的 dossier 已通过 Python `failure_clusters` 消费测试。

17 项诊断运行回归通过：实际结算、同批额度、丢响应、结算写入失败、未知状态、明确未开始、取消、身份变更、预算耗尽、六类非法结果、配置准入和真实默认 Python recipe 闭环。两项 Python 预算测试覆盖 GEPA/StagedGEPA 的耗尽提名、局部计划排除和原父代配额保留。真实 Python 进程使用离线 provider，未调用 Luna。

协议追加 `seed_diagnosis_budget: requests-and-tokens-v1`、可空的剩余诊断预算及四组正反例，原 47 组 payload 样例保持不变，现为 51 组。项目回归 229 项全部通过；Python 全量 367 项中 363 通过、4 跳过。Ruff（42 文件）、Mypy strict（38 文件）、typecheck、Biome、210 模块边界和协议生成检查通过。补充跨语言 dossier 探针后定向 17 项再次通过；真实 macOS worker sandbox 两项通过。

独立安装 tgz/wheel 后，两种 Target 布局分别通过诊断 → 绑定生成 → seed → gate → report/resume，实际用量与零未结算预留均符合预期；六组模板、SDK、双作者 CLI、源码封存、CPU 训练和恢复继续通过。该发布探针仍是离线 fixture，不能视作原生模型计量的验证。

边界：原生 DSH/Pi 的模型请求前硬限制和可信实际用量采集尚未实现，内置 provider 在显式开启诊断预算时会于 baseline 前拒绝。当前来源认证覆盖 seed 评分日志，不等于已迁完原始 verifier、重复槽位和 objective 合同；丰富 workplan 消费审计与修改边界仍待接入。未修改 README、历史身份或原工作区，M3 继续保持部分完成。

## 生成的完整算法 payload 合同

`contracts/algorithm-v1.json` 的 `$defs` 生成候选、视图、操作、决策、输入及完整请求/响应的 TS 类型和 Python TypedDict；TS domain 改为薄类型转发，Python 作者保留 dataclass 并复用生成枚举。运行时、Python worker 和离线 testkit 使用生成 schema 的同一结构定义，移除旧手写 TS 类型以及重复的结构检查。生成器遇到未支持的关键字或冲突继承字段即失败，`check:protocol` 检查输出一致。

新增 `algorithm-payload-v1` 与 64 层上限的能力声明；缺失/未知固定字段、非法 null、非有限数、非安全整数、布尔预算、重复任务、超量操作、非 JSON 对象、循环和非法 Unicode 被拒绝。开放的算法状态及回执扩展仍须是有界 JSON。JSON 的 `1` / `1.0` 按同一整数值接纳，Python 包装预算时显式转为 int；输入摘要保持原 canonical 语义。消息严格 UTF-8、单行且以换行结束，1 MiB 计入该换行；响应关联、重复响应、能力错配、坏 JSON、取消、崩溃及过大输出有拒绝回归。结构错误不包含数据值或用户 map key。

`test-contracts/algorithm-payload-v1.json` 的 47 组正反例由声明合同固定，不由新校验器反推期望；TS/Python 分别对同一文件验证。6 项 Python 测试另外检查作者 dataclass 字段覆盖、开放状态边界、加载插件前拒绝坏输入、写 stdout 前拒绝坏输出和非 UTF-8 输入。内核新增进程内算法的未知操作字段拒绝测试，确认不提交 decision/state 或生成 reservation。结构检查不替代 seed 权限、预算、证据认证或最终 gate。

最终项目回归 208 项通过；Python 全量 365 项中 361 通过、4 跳过。Ruff（42 文件）、Mypy strict（38 文件，含生成传输类型与校验器）、typecheck、Biome、207 模块边界和协议生成检查通过。真实 macOS worker sandbox 两项通过；独立 tgz/wheel 的六组模板、两种 Target、SDK、双 CLI、CPU 训练及恢复通过。中断前两个本地进程未留下完成结果，确认句柄不存在后重跑以上项目/安装检查；没有将中断当作成功。生成文件末尾空行由 diff 检查发现并在生成器中修正。

本轮未调用模型，未修改 README、历史身份或原工作区。M3 的模型计量与证据认证、完整历史 GEPA 迁移、剩余执行层拆分、公共导出约束及人工验收仍见目标跟踪表。

## 诊断、提案策略与固定生成引用

`test-contracts/gepa-diagnosis-v1.json` 固定了源提交 `c17efd2` 的 10 组旧 TS 诊断/交付结果，覆盖未解析事实不升级为根因、受保护失败与任务数排序、多假设/路径/子模式合并、同族/同分层/同路径成功对照、scope 摘录、Unicode 顺序及同题多族。旧诊断实现没有修改；双语言分别比较冻结输出，历史身份作为不透明引用保留。新的 Python 策略实现已认证 dossier 聚合、配额去重、workplan、摘录与回执校验；新身份在独立 canonical 域产生。

默认 GEPA 的 generate 显式绑定 `diagnosis_id`。运行时在预留写入时冻结未显式指定的引用，Meta 接收相同 ID 和内容；成功及无效生成均保留引用。回归构造同一父代的两份诊断，指定较早一份，在生成响应丢失后恢复，验证原引用、原 decision 和一次生成保持不变。另验证进程内算法伪造 view.completed 和修改状态不能绕过校验，失败不污染持久化输入。真实 Python 默认 GEPA 闭环及 StagedGEPA 批次验证同一引用传递和终态恢复。

协议能力增加 `generation_diagnosis_binding: receipt-v1`，生成后的双语言常量一致；缺少能力时在导入用户插件之前拒绝。Python 新增 5 项诊断策略测试，项目新增 10 个固定样例、对应 Python 合同、两项运行时恢复/隔离和一项真实 worker 闭环。项目 155 项通过；Python 全量 359 项中 355 通过、4 跳过；无效生成引用补充后的运行时 37 项通过。Ruff lint/format（41 文件）、Mypy strict（36 公共文件）、typecheck、Biome、205 模块依赖与协议生成检查通过。macOS 实际 worker sandbox 两项通过。

独立 tgz/wheel 验证通过，新增安装后用公开 API 完成 dossier → cluster → hypothesis → workplan → delivery → receipt；首次新探针因错误地从根入口导入 ArchiveScope 失败，改用其已有公共模块后重跑通过。六组模板/Target、双算法 CLI、SDK、源码封存、CPU training 与恢复继续通过。未新增 Luna 调用，所有 README、原用户工作区及历史身份未修改。

边界：丰富 workplan 尚未接入 StagedGEPA/真实 Meta；模型诊断端口、请求/token 硬计量、原始证据认证、实际阅读审计和修改边界执行仍待完成。GenerationBudget 是声明合同，消费回执当前是纯验证规则，不能据此声称真实模型已读取证据或完整历史 GEPA 等价。

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

## 周期 scope 准备与 archive 阶段集成

`StagedGEPA` 的状态显式升级为 `staged-gepa-v2`。运行内 catalog、scope/候选登记、题族历史、共享 epoch 输入和父代选择写入原有 decision 状态；原始评分仍从 runtime 的 seed-only view 投影，不复制 evidence journal。默认从多 scope 前沿抽一个父代批次；局部完整的历史候选可继续探索，最终提名仍须完整 seed。原 `parent_policy=fn` 可覆盖完整 seed 父代，原构造位置参数保持顺序。独立评分/预算投影移至 `stage_evidence.py`，准备与生成计划移至 `stage_planning.py`，移除 staged 中的重复实现。

`EpochPolicy` 默认稳定复用；周期模式先冻结旧 archive 的父代，再冻结每个新 scope 的必需/可选参与者和 evaluate 操作。champion 与从该旧 scope 选出的父代不能因预算不足被删除，可选历史候选依概率从末尾剔除。新 scope 的整组 baseline 完整且通过 must-pass guards 才登记；否则保留旧 scope。新 scope 不导致当前父代重抽，后续批次才使用更新后的 archive。每个 epoch 的共享成功题输入只冻结一次；修正了同 epoch 随父代变化重采样的可能性。guards 从实际 seed pass scores 判断，冻结身份通过公开 helper 构造，越界/错配身份被拒绝。

新增 `test-contracts/gepa-epochs-v1.json`：13 组期望值来自未修改的旧 TypeScript `prepareScopeEpochs`（源提交 `ea7b02e`），覆盖 cells/repair 预算、必需参与者、历史候选剔除、缓存、无历史、等价 scope、稳定/周期边界。fixture 预先冻结 proposed scope，验证的是准入与开销合同；scope 选题由既有采样 fixtures 验证，不能合称完整历史计划序列等价。

6 项 Python 测试覆盖上述固定对照、多批次 catalog、局部父代、缺失 baseline 保留旧资格、共享输入冻结、guard 校验、输入不变和 v1 状态拒绝。实际 Python 协议 worker 经 durable runtime 运行四次生成，并在 epoch 评测已完成但响应丢失时中断；恢复复用原 decision、父代及参与者，新 scope 在确认完整前未启用，未重复物理提交，终态 resume 一致。

本地项目 116 项通过；Python 全量 341 项中 337 通过、4 跳过；Ruff、31 个公共模块 Mypy strict、typecheck、Biome、204 模块边界与协议检查通过。macOS worker sandbox 两项通过。独立 tgz/wheel 通过，安装后的 wheel 可使用 `EpochPolicy` 配置 StagedGEPA，六组模板/Target、CPU training 恢复、SDK 和双算法 CLI 继续通过。没有新增模型测试，没有改写旧 run 身份、README 或原工作区。

仍未完成：跨 run archive 与历史证据修订、历史难度/诊断的完整来源、process/objective、多父代批次、regression proposal、全序列 shadow/replay 与默认算法切换。此处完成了运行内周期准备及恢复，不代表 M3/M5 全部验收。

## Python 历史采样证据与截止点

新增 `gepa/history.py`，从可信的 seed task/condition/version/slot 引用和归一化 utility 投影历史难度，并合并已经提交的题族、成功对照、子模式和修改路径。某版本缺少任何任务重复槽位时不计为失败；有效零分保留，冲突的有效结果拒绝。显式 objective 不推导隐式历史难度。Python 不认证原始 trial，也不另建原始证据数据库。

`test-contracts/gepa-history-v1.json` 固定了源提交 `420c6f2` 未修改的旧 TypeScript `samplingEvidence` 的 10 组输入/输出，覆盖无历史、完整/部分槽位、重复结果、无效观察、分数均值阈值、minimize、逐题重复清单、相同内容的独立执行版本、Unicode 诊断标签和 objective。两种语言独立比较固定结果，没有从新 Python 实现生成期望值。旧证据认证、跨运行来源和完整决策序列不在这组 fixture 的验收范围。

runtime 的 seed view 投影移至 `project-view.ts`，新增可选执行身份、逐题证据引用和条件身份；内容相同的共享缓存别名去重，独立执行保留不同版本。现有 runtime identity 遍历整个 runtime 层，新模块正常进入新身份闭包；历史数据和摘要规则未改。Python worker、toy 和已有构造方式兼容新增字段，不向作者暴露原始结果或 held-out 内容。

`ScopeSampler` / `StagedGEPA` 共用历史投影。分阶段计划冻结批次已知覆盖和派生元数据，当前父代仅可加入其本次 probe 的新证据。检查中修复了成功对照读取范围过宽的问题：其他 scope 准备中新获得的成功评分不再改变当前诊断。独立回归验证 cutoff/元数据稳定、缓存别名不增加难度权重、缺失或越界引用拒绝；真实 Python worker 验证新字段传递，准备阶段断线恢复保持原 decision 和采样截止点。

最终本地验证：项目 128 项通过；Python 全量 348 项中 344 通过、4 跳过；7 项历史投影测试包含上述 10 组固定对照；Ruff lint/format、32 个公共模块 Mypy strict、typecheck、Biome、205 模块边界与协议生成检查通过。macOS worker sandbox 两项通过；最终源码的独立 tgz/wheel 六组模板/Target、共享应用闭环、CPU training 恢复、同步/异步 SDK、双算法 CLI 通过。文档链接、Python 示例和 README 保护检查通过。本轮无新模型调用。

当前可计算运行内完整执行版本的历史难度，并接收已验证诊断元数据；完整模型诊断、跨运行历史认证/修订、process/objective 执行、多父代批次、regression proposals、全序列等价和默认切换仍待完成。

## Python 完整父代批次与 v3 阶段

`StagedGEPA(parent_selection_policy=...)` 现使用公开 `(ParentInput, RandomSource) -> ParentPlan` 合同，保留全部 allocations，校验父代/scope/概率与候选额度后展开有序 `ParentBatch`。批次来源、slots、draw index、branch、整个输入摘要和随机种子在任何准备操作之前冻结；原单父代覆盖仍可用，两种覆盖同时设置会拒绝。新状态明确为 `staged-gepa-v3`，v1/v2 需匹配原冻结 runtime，默认 `algorithm: gepa` 仍未切换。

`test-contracts/gepa-parent-batches-v1.json` 的 55 份期望由未修改的旧 TS `selectParentsWithPolicy`（源提交 `a306123`）从已有固定父代计划展开。双语言比较每个批次及原顺序，覆盖多个 scoped 配额、champion/GEPA 分支和随机索引。已有 archive fixture 生成辅助函数只抽出共同输入构建，原 11 组 archive / 55 份父代计划保持逐值通过。此处不宣称完整历史生成计划或预算等价。

周期准备把同一旧 scope 的全部已选父代列为必需参与者，预算不足时不能剔除其中一个。局部计划按每批 slots 生成；重复的父代/题族在本轮去重，未用额度不隐式转移。所有 local baselines 按父代/任务并集报价，再保留候选评测与完整 seed 扩展余量。每批采样只读冻结历史与自身 probe；新增控制题和准备结果不会串入其他批次。每批保存 cutoff 和元数据摘要，500 题/16 批次的 decision 与后续 request 投影均在公开 worker 消息上限以内。

父代冻结、catalog/投影、epoch 编排和 local 计划分别放入 `stage_parents.py`、`stage_catalog.py`、`stage_planning.py`、`stage_locals.py`；原单父代规划实现已移除。阶段 orchestration 不另建执行器、证据日志或预算系统。

真实 Python 协议 worker 运行六次生成，在两个不同父代的周期准备已经执行但响应丢失时中断。恢复保留原全部分配、必需参与者与 decision，随后从两个父代分别生成，没有重抽或重复物理提交；终态 resume 一致。回归中发现新公开示例与测试 fixture 同名，Python 搜索路径加载了示例；测试 fixture 更名后重新完成上述故障注入。`examples/python-algorithm/multi_parent.py` 同时通过安装后的 wheel 与两种 CLI 作者检查。

最终本地项目 141 项通过；Python 全量 354 项中 350 通过、4 跳过，含 6 项批次合同测试；Ruff、35 个公共模块 Mypy strict、typecheck、Biome、205 模块边界与协议检查通过。macOS worker sandbox 两项通过，最终 tgz/wheel 含多父代示例的双 CLI、六组模板/Target、CPU training 恢复及 SDK 均通过；文档链接、示例语法和 README 保护检查通过。本轮无新模型调用。完整模型诊断与 hypothesis、regression proposals、process/objective、跨运行 archive/修订、全序列 shadow/replay 和默认切换仍未完成。

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
