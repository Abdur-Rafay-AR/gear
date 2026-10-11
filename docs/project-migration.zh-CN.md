# 项目接口 v1 与迁移边界

本次基于 origin/dev `9a1281dba7495ea454c637d1bbad4e1605f52db6`。README 不变。新 CLI 为 `gear`，新 Python distribution 为 `rsi-gear`（与 npm 同版本），导入名为 `gear`。旧 `gear-refine`、稳定 TS exports、`gear_training` import 和 `gear-training` CLI 保留至少一个兼容发布周期。

| 旧入口 | 新入口 | 兼容行为 |
| --- | --- | --- |
| `gear_training.X` | `gear.training.X` | 同一个模块对象的薄转发 |
| `python -m gear_training.job` | `python -m gear.training.job` | 转发到唯一实现 |
| `gear-training` | `gear-training` / `python -m gear training` | canonical training 实现 |
| `gear-refine` evolution | `gear` project | 独立状态版本，不能原地切换 |
| TS `failure-cluster-gepa-v2` | Python project recipe v1 | 不宣称跨算法等价，不复用决策日志 |

项目 gate 现显式冻结 `paired-pass-rate-v1`：完整 seed 必须改善，随后独立 held-out 不得退步；seed 未改善时不提交 held-out，报告中对应评分为 `null`。这修正了首批实现仅要求 held-out 涨分的偏差，并以旧 GEPA 的 16 组二元评分组合交叉验证。研究模式只使用 seed，并保持研究标识。已有 run 继续使用其冻结 runtime；不重写旧 plan 或 gate。

新项目状态在 `.gear/`，包含原子 run 记录、provider operation receipts、不可变 Git Target 快照和导出物。decision、算法状态和 operation 预留写在一个原子记录中；provider 外部操作状态单独核对。历史 `.gear-refine`、manifest v1 和旧 digest 均不重写。新 canonical digest 有独立 `gear-canonical-v1` 域。

训练模块迁移会改变新运行的模块名与源码身份。旧 import 转发通过，不代表新版本可以恢复活跃旧任务。活跃旧 run 必须继续使用启动时锁定的 npm/wheel、解释器和后端；旧 checkpoint 来源与预算记录保留原样。无需迁移状态即可读取原报告。回退时先终止或核对新 run 的外部操作，再选择原入口和匹配版本；旧 runtime 不读取新项目状态。

本分支的项目 recipe 是明确版本化的新流程：全 seed 比较、失败题局部检查、最终 held-out gate。历史 GEPA 的完整多 scope archive、regression proposal、通用 objective 和自动 repair 仍由旧入口提供；可选 Python 分阶段 recipe 的局部权重与 bridge 进展见下文。它们尚未全部等价迁入 Python；不得把此分支标为设计规范 M3/M5 全部验收完成。旧 service 的 baseline 复用、证据投影、生成状态、评测修复和提交状态已拆为独立模块；Hitch 的 verifier/result/trajectory 解码和进程 transport 已独立，并全部纳入新的组件实现摘要。旧 capabilities 的经验查询与分页、轨迹投影缓存、参数校验和有界文本展示已拆成独立模块，旧 facade 保持鉴权与诊断流程；其余 orchestrator 和兼容实现仍保留，新的 domain/ports/runtime/adapters 边界由 CI 检查，后续迁移不能弱化原合同。

发布检查脚本 `scripts/check-project-package.mjs` 从真正的 tgz/wheel 安装，验证三套模板、两个 Target、共享应用的 evaluate/refine/report/resume/export、CPU 导入和 SDK。离线 provider 证明调用与恢复合同；真实 Luna/Target 和 Docker/verifier 分别验收。设计规范中的五名新用户易用性测验需要实际参与者，不能用自动化结果替代。

Python 已提供历史 shared/local/cross 采样的纯函数与可选 `ScopeSampler`：成功对照、难度/成本分层、模块覆盖、题族分配、guard-only 零权重、epoch 和容量解释由同一份 10 组固定 fixture 与旧 TypeScript 交叉验证。默认 recipe 未切换；这个适配器只替换选题；局部加权阶段见下文 `StagedGEPA`，动态 scope 生命周期仍待完整迁移。新 API 不生产历史 digest、不复用旧 archive 或决策日志；不能据此宣称完整 GEPA 等价。发布包检查还从安装后的 wheel 执行 `GEPA(task_sampler=ScopeSampler())` 的 CPU toy round。

随后新增可选 `StagedGEPA`：完整 seed 前沿父代策略、按题族批量生成、局部加权提名、共同 bridge 评测、global seed 扩展和最终 gate 已通过 Python worker 与共享 runtime 的离线闭环及断线恢复。frontier/bridge 的策略核有另外 20 组旧实现固定 fixture；前沿消费已经验证的比较键，不自行维护证据或 archive journal。当前 recipe 仍仅支持 pass-rate，不等同于历史全部 GEPA 能力；历史多 scope 等价/epoch 生命周期、process/objective 执行、regression proposal 仍待迁移。旧 locale 排序只在显式冻结顺序下比较，新 recipe 采用固定 UTF-16 顺序。

`Candidate.content_digest` 是可选的只读 Target 内容身份，用于阻止相同代码在父代抽样中重复占位。旧的两参数 Python `Candidate(id, scores)` 和缺少该字段的 worker 输入继续可用；没有身份时不会推测内容相同。runtime 和算法源码身份正常变化，活跃旧 run 仍需匹配的冻结版本。CPU toy 也已对齐有效零分复用：重复请求已有观察不覆盖评分、不重复扣减预算。

作者路径新增 `Project.open`、同步/异步 SDK、`refine(algorithm=...)` 和 `gear algorithm test` / `python -m gear algorithm test`。`Project(path)`、原来的 gear.yaml factory 和 `toy_round` 继续有效。单次算法覆盖只写入新 run binding；对象经普通 Python 源码封存交给原 worker，不能借此恢复采用不同身份的旧 run。源码变更应开新 run，已封存目录不可覆盖。异步取消本地客户端不等于取消 provider 任务，后者仍需显式核对和取消。CPU testkit 已集中为唯一 toy 执行实现，Benchmark facade 通过公开 Project 方法调用，不再依赖私有 `_request`。

多 scope archive 的纯投影现已迁入 Python：按题族选择最新可用 epoch、保留尚未被可用新版替换的旧 scope、去除语义等价 scope 的重复概率，并区分候选实例与 Target 内容身份。`ParentInput` / `ParentPlan`、索引随机源及 scoped/champion 混合策略有 11 组旧实现 archive 和 55 份父代分配固定对照；公开 `archive_policy.py` 示例通过项目运行层的完整离线回合。原始证据认证与 revision 仍由 runtime 负责，不能将这些纯函数视为已迁移完整历史 archive 生命周期。周期性 scope 准备、历史难度和 adaptive epochs 仍未接入默认 recipe。

完整 seed 的 `FrontierParentPolicy` 复用同一 archive 投影，随机选择实现集中到 `RandomSource`，原公开 frontier imports 保留。局部采样修正为只把已观察的低分题视为失败，未观察题不再隐式按零分分类。新模块正常进入算法源码身份；不重算旧数据或修改历史身份，活跃旧运行继续使用其冻结版本。

后续 `StagedGEPA` 已升级为明确的新状态 `staged-gepa-v2`：多 scope 父代、scope catalog、题族历史与每个 epoch 的共享输入进入原子 decision；周期准备通过原 runtime 评测，完整且满足 guard 后启用新 scope。默认稳定复用，`EpochPolicy(update_every_rounds=...)` 显式启用周期变化。v2 选择局部完整父代，先补齐 local baseline；旧版只从完整 seed 选择父代，并重新生成局部 scope。这个变化有新源码身份与状态版本，不能直接恢复 v1。原先的构造位置参数保持顺序，原 `parent_policy=fn` 覆盖保留完整 seed 合同。

13 组旧实现固定 proposal 的 epoch 准入比较覆盖 cells/repair 预算、参与者剔除、缓存、周期边界和等价 scope；scope 采样另有独立固定样例。真实 Python worker 的准备阶段中断后恢复不重抽父代、不重复提交，终态 resume 一致。此处的 catalog 属于单 run 的算法计划状态，原始证据与预算仍由 runtime 拥有；跨 run 历史 archive、证据修订和完整历史诊断尚未迁完，不能宣称默认历史 GEPA 等价或切换完成。

历史采样元数据现迁入 `gear.algorithms.gepa.history`，并接入 `ScopeSampler` / `StagedGEPA`。完整重复槽位才形成一个有效执行版本，难度按失败版本占比计算；无效、缺失和冲突有独立处理。题族/成功对照/子模式/修改路径来自已提交诊断。10 组固定样例来自未修改的旧 TypeScript，覆盖归一化阈值、minimize、重复证据和 objective 不隐式推导难度。

新 worker 输入增加可选 `execution_digest`、`score_evidence` 和 `evidence_condition`。执行身份与 Target 内容身份分开：共享缓存别名去重，独立执行的相同内容分别保留。旧构造和缺少字段的自定义 view 继续可用；新 runtime 只传 seed 分数与不含原始内容的引用。运行内冻结采样截止点不重算历史摘要，也不接管原始证据日志。完整历史导入/修订、模型诊断和 process/objective 执行仍是后续迁移项。

`StagedGEPA` 的最新状态为 `staged-gepa-v3`。新增 `parent_selection_policy(ParentInput, RandomSource) -> ParentPlan`，完整分配列表经校验后展开为有来源 scope、父代、额度和随机索引的批次；默认仍为一个分配，原单父代覆盖保持兼容，但两种覆盖不能同时配置。v1/v2 状态需匹配原冻结 runtime，不原地转写。55 份旧 TS 完整批次输出与 Python 对照通过。

周期准备保留从同一旧 scope 抽出的全部父代；局部计划按每个批次的额度执行，重复父代/题族去重，重叠父代 baseline 按槽位并集报价。各批次只有冻结 archive 元数据和自己的探测证据，完整分配、排除原因与输入摘要进入原 decision。父代冻结、catalog、epoch 编排和局部计划已拆分，移除原单父代规划实现。真实 Python worker 的多父代回合及准备阶段恢复已有离线证据；完整模型诊断、regression、objective 与跨运行 archive 仍待后续迁移。

诊断/提案纯策略现迁入 Python：已认证 dossier 的失败族、成功对照、假设配额与去重、候选 workplan、限定摘录和消费回执，分别对照 10 组未修改旧 TS 输出。新摘要仅用于新合同；旧 dossier 等身份作为不透明输入原样保留。该阶段尚未接入模型诊断、原始证据认证、实际消费审计及修改边界执行；`GenerationBudget` 仅声明限制，不能视为已有模型计量。

`Operation` 末尾新增可选 `diagnosis_id`，保留旧 Python 位置参数和未绑定生成调用。默认 GEPA 显式引用已提交诊断；未绑定的批次操作在 runtime 预留时冻结所选诊断。断线后的 inspect 和完成回执沿用该引用，成功与无效生成均保留来源。协议增加 `generation_diagnosis_binding: receipt-v1` 能力，TS/Python 必须匹配，不让旧 worker 静默忽略新语义。协议 envelope 仍为 v1；这不等于完整 wire payload schema 已生成。历史 run 使用原冻结 runtime，不迁写其日志或身份。进程内算法改为独立输入副本，runtime 以原视图校验返回决策。

随后补齐完整 payload 字段的生成与结构校验：合同 `$defs` 生成 TS/Python 候选、视图、操作、决策和消息类型，替代手写 TS 重复类型。作者 dataclass 保留原位置参数和默认值；可空的内容/执行/诊断身份与 evidence condition 明确区分于不可为空的容器。状态和回执扩展仍是有界 JSON 对象，业务证据认证不委托给 schema。

新增 `payload_schema: algorithm-payload-v1` 与 `max_json_depth: 64` 能力。未知固定字段、非法数字/Unicode/JSON、超深内容、重复操作任务、超过 64 个操作会在外部执行或状态提交前拒绝；消息上限包含结尾换行。响应必须是一条 UTF-8 JSON 行，重复和过期回复不被接受。旧 worker 不满足能力协商时明确拒绝；不原地迁写旧 run 身份或数据。当前 scope/diagnosis 等固定历史比较保持原规则，这次收紧只适用于新运行的 wire 合同。

独立诊断的运行层合同现已接入：可选 `ProjectProvider.diagnosis`、显式 `budget.diagnosis` 和冻结的 provider 身份。未配置仍走零模型调用的评分投影。配置后缺少合格端口时在 baseline 前拒绝；原生 Docker DSH/Pi 尚未具备请求前硬限制和可信模型用量采集，不能仅凭容器次数启用这项能力。

诊断单独预留请求/input/output token，写入实际用量后再认证同父代 seed 日志引用；坏事实和超额结果不抹去已发生费用。恢复保持原操作、输入和预留，未知状态不重发；只有明确的 `not-started` 允许原输入提交。端口取消与主评测 provider 分离。回执可直接供 Python `failure_clusters` 消费，但不宣称已完成原始 verifier、重复槽位或 objective 证据认证。

生成协议新增可空 `diagnosis_budget` 和能力 `seed_diagnosis_budget: requests-and-tokens-v1`。旧 worker 不满足能力时明确拒绝；Python dataclass 只在末尾增加可选参数。GEPA 和 StagedGEPA 根据余额结束或排除新诊断，已经执行的候选仍可完成评测与提名。新源文件照常进入实现身份，新运行使用新合同；历史 run 继续使用其冻结 runtime，不迁写旧状态、摘要或数据。
