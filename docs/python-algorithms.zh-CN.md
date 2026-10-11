# Python 算法修改入口

`gear.algorithms.GEPA` 是项目接口 v1 的 Python recipe。它显式分阶段返回决策；执行、预算、持久化和最终 gate 归 TypeScript。历史 `failure-cluster-gepa-v2` 保留在原入口，两个版本不会混用恢复状态。

| 想改什么 | 公开入口 | 实现位置 |
| --- | --- | --- |
| 选父代 | `GEPA(parent_policy=fn)` | `gear/algorithms/gepa/parents.py` |
| 从完整 seed 前沿抽父代 | `GEPA(parent_policy=FrontierParentPolicy())` | `gear/algorithms/gepa/archive.py` |
| 多 scope archive 与父代配额 | `project_seed_archive`、`ScopedFrontierPolicy`、`ChampionGepaPolicy` | `gear/algorithms/gepa/research.py`、`parent_plan.py`、`parent_policies.py` |
| 选局部题目 | `GEPA(task_sampler=fn)` | `gear/algorithms/gepa/sampling.py` |
| shared/local/cross 选题 | `GEPA(task_sampler=ScopeSampler(...))` | `gear/algorithms/gepa/scopes.py` |
| 提案计划 | `GEPA(proposal_planner=fn)` | `gear/algorithms/gepa/proposal.py` |
| 已认证诊断的失败族 | `failure_clusters`、`DiagnosisDossier` | `gear/algorithms/gepa/diagnosis.py` |
| 假设配额、交付与消费回执 | `plan_hypotheses`、`candidate_workplan`、`deliver_workplan`、`validate_receipt` | `gear/algorithms/gepa/proposal.py` |
| 排名/提名 | `GEPA(candidate_ranker=fn)` | `gear/algorithms/gepa/ranking.py` |
| 何时停止 | `GEPA(stop_rule=fn)` | `gear/algorithms/gepa/stopping.py` |
| 整个流程 | `SearchAlgorithm.step(view, state)` | `gear/algorithms/gepa/algorithm.py` |
| local → bridge → global 流程 | `StagedGEPA(...)` | `gear/algorithms/gepa/staged.py` |
| 历史难度与诊断标签 | `sampling_evidence`、`project_sampling_evidence` | `gear/algorithms/gepa/history.py` |
| 完整父代配额策略 | `StagedGEPA(parent_selection_policy=fn)` | `gear/algorithms/gepa/stage_parents.py` |
| scope 周期更新与准入 | `EpochPolicy(...)`、`admit_scope_epoch` | `gear/algorithms/gepa/epochs.py` |

一个文件就能换父代策略：

```python
from gear.algorithms import GEPA
from gear.testing import toy_round

def choose_parent(view):
    return view.champion

def build_algorithm():
    return GEPA(parent_policy=choose_parent)

if __name__ == "__main__":
    print(toy_round(build_algorithm()))
```

保存为 `algorithm/policy.py`，先运行下面任一离线检查；Python 命令不需要 Node、模型、GPU 或项目数据，Node 命令转发到相同检查器：

```sh
python -m gear algorithm test policy:build_algorithm --source ./algorithm
gear algorithm test policy:choose_parent --source ./algorithm --kind parent
```

`--kind auto` 默认把可无参调用的入口当作算法 factory，其余入口当作父代策略。需要区分带默认参数的函数时显式指定 `algorithm` 或 `parent`。检查器在固定 CPU toy 中验证相同输入的决策重放、输入不被修改、seed 范围、候选分配、完整 seed 提名和操作数量。它不执行真实 Target，不证明搜索收益或覆盖所有输入。作者打印内容走 stderr，JSON 结果独占 stdout。Python 中也可直接调用 `gear.testing.check_algorithm(instance)`；`toy_round` 保留为较轻的模拟执行器。

对后续所有运行使用该 factory，在 gear.yaml 写 `algorithm: {source: ./algorithm, entrypoint: policy:build_algorithm}`。只对一次运行改策略，可直接传 Python 对象：

```python
from gear import Project
from gear.algorithms import GEPA
from algorithm.policy import choose_parent

project = Project.open(".")
result = project.refine(algorithm=GEPA(parent_policy=choose_parent), rounds=1)
```

SDK 把可导入的顶层函数/类、dataclass 配置及其静态本地 Python imports 封存到 `.gear/algorithm-sources/<digest>`，再交给原有受限 worker；不使用 pickle，不修改 gear.yaml。编辑作者源码产生新 bundle，已运行的 bundle 保留；篡改已封存源码会拒绝继续。脚本内定义策略时，把执行 SDK 的部分放入 `if __name__ == "__main__":`，避免 worker 导入时再次启动项目。

闭包、lambda、交互式定义和任意有状态构造器、含 `init=False` 字段的 dataclass 不能自动封存。动态导入或需要自定义构造的算法使用显式源码目录和无参 factory：`project.refine(algorithm=AlgorithmSource("./algorithm", "policy:build_algorithm"))`，其中 `AlgorithmSource` 来自 `gear.algorithms`。目录只收集 `.py` 文件，限制为 256 个文件/1 MiB，不接受符号链接或覆盖 Gear 命名空间。第三方依赖由受管 Python 环境提供并纳入已有运行身份；源码 bundle 不代替依赖安装。分发包中的 `examples/python-algorithm/policy.py` 展示单策略修改，`one_shot.py` 展示独立的完整 `SearchAlgorithm`；两者均通过安装后的 wheel 和 npm CLI 检查。

`Project` 提供 `acheck/aevaluate/arefine/areport/aresume/acancel/acompile/aexport/aconfig`，例如 `result = await project.arefine(algorithm=GEPA(), rounds=1)`。异步接口等待子进程时不阻塞事件循环，使用相同应用服务和结构化错误。取消 Python 等待会回收本地 CLI 进程；已提交的外部任务仍按持久化记录核对，需显式 `acancel(run_id)` 或 `aresume(run_id)`，不会因客户端消失而重发。`gear.refine.arefine` 和 `Benchmark.acheck/acompile` 也提供相同异步入口。

需要按题族抽样时，可显式换用 `ScopeSampler`：

```python
from gear.algorithms import GEPA, ScopeSampler
from gear.algorithms.gepa.scopes import ScopeConfig, TaskSetLimit

def build_algorithm():
    return GEPA(task_sampler=ScopeSampler(ScopeConfig(
        local=TaskSetLimit(ratio=0.08, min_tasks=2),
        shared=TaskSetLimit(ratio=0.04),
        cross=TaskSetLimit(ratio=0.03),
    )))
```

这个适配器要求父代的全部 seed 评分已观察到；缺失评分不会当成失败。它选失败最多的题族（并列按 ID 的 UTF-16 顺序），从 `view.random_seed` 确定顺序，用该题族成功题作对照、其他成功题作共享范围，另选跨题族题目。全部通过时返回完整 seed。历史难度由可信 seed 评分按完整执行版本计算，缺失评分保持未知；成本暂按 1。它只替换局部选题，后续仍完整评测 seed，并使用项目 pass-rate gate。

高级策略可使用公开 `gear.algorithms.gepa.scopes` 中的 `SamplingTask`、`FailureFamily`、`ScopeConfig`、`resolve_sizing` 和 `create_scope`，传入已经核验的 seed 元数据，取得 buckets、归一化权重、guard 题目和容量不足原因；`epoch` 控制重采样。这里移植了旧 GEPA 的成功对照、难度/成本分层、模块覆盖、跨题族分配、十进制比例取整及 guard-only 零权重。`ScopeSampler` 只消费返回的任务 ID；默认 `GEPA` 仍只消费选题结果；下文的 `StagedGEPA` 接入局部权重、must-pass guard 和 bridge，多 scope archive 生命周期与 process/objective 执行仍待完整迁移。调用方不能把未验证的历史难度当成运行时证据。

`test-contracts/gepa-scopes-v1.json` 固定了旧 TypeScript 在 10 组输入上的输出；两种语言各自对同一份 fixture 验证语义结果。旧摘要和 run identity 不在此比较范围，Python 不生成旧 run 的身份，也不读取旧状态。这是采样模块的迁移证据，不代表整个历史 GEPA 流程等价。

`gear.algorithms.gepa.history.sampling_evidence` 接收已验证的 task contract、执行条件、版本、重复槽位、归一化 utility 和证据引用。仅当某个版本的全部任务槽位有效时，它才计入该题历史难度；有效零分不能被缺失覆盖，冲突的有效结果会拒绝。函数合并已提交诊断中的失败题、成功对照、子模式和修改路径；原始结果认证和 revision 冲突处理仍由可信运行层负责。设置 `objective=True` 时不计算隐式难度，这不表示当前项目已支持通用 objective 执行。

项目适配器 `project_sampling_evidence(view)` 使用 v1 的单次 pass-rate 槽位。runtime 提供 `Candidate.execution_digest`、逐题 `score_evidence` 和 `SearchView.evidence_condition`：共享缓存别名计为同一执行版本，独立执行的相同 Target 内容分别计数。只有 `content_digest` 时不能推测证据复用；旧 toy/custom views 按候选 ID 区分版本。新增字段可省略，原来的构造参数顺序保持兼容。

`ScopeSampler` 和 `StagedGEPA` 共用这个投影。Staged 在批次开始冻结采样元数据和已知题目集合，准备阶段只允许当前父代在本次探测范围内的新证据进入后续诊断，避免其他 scope 的准备结果改变当前采样。状态只保存 cutoff、派生元数据和计划，不复制原始观察。当前自动诊断仍是确定性 seed 评分分类，不生成未知的模块路径或子模式。

`test-contracts/gepa-history-v1.json` 的 10 组旧实现固定样例覆盖重复槽位完整性、缓存去重、独立版本、无效观察、阈值与最小化 utility、诊断标签合并和 objective 的未知难度。它验证历史元数据投影，不替代完整 GEPA 决策序列或跨运行历史导入的验收。

另一个可选完整 recipe 是 `StagedGEPA`，同样通过 `algorithm/policy.py` 的 factory 使用：

```python
from gear.algorithms import StagedGEPA

def build_algorithm():
    return StagedGEPA(batch_size=2, bridge_max_candidates=2)
```

首轮用完整 seed bootstrap，后续从已登记的多 scope 前沿抽父代；局部证据完整的历史候选也可以继续探索。默认父代策略返回一个分配；`parent_selection_policy` 可返回多个。每份分配按其 source scope 中实际观察到的失败题族生成候选，先补齐各 local scope 的父代 baseline。局部加权评分严格改善且所声明 guard 题目全通过的候选可以提名进入 bridge。bridge 包含候选 scope 的并集、guard 及分层补充题，所有参与者在同一范围比较，然后为胜者补齐完整 seed。最终仍由运行层执行固定 gate。`batch_size` 为本轮所有父代合计的候选额度（1–16）；`scope_config` 使用上述 `ScopeConfig`，可调整 `bridge` 比例。容量不足以装下一个完整 scope 时会记录排除原因，不会截断 scope 或放大用户额度。显式 `parent_policy=fn` 继续接收原单参数 `SearchView`，该覆盖策略必须返回完整 seed 且满足 guard 的父代。

完整父代策略的签名是 `(ParentInput, RandomSource) -> ParentPlan`，通过 `parent_selection_policy` 传给 `StagedGEPA`；不能同时指定单父代 `parent_policy`。每份 allocation 的来源 scope、父代身份、额度、draw index 与 branch 都进入持久化的 `ParentBatch`；整个计划在任何准备操作前校验并冻结，同时记录输入摘要与随机种子。返回 `ParentPlan.abstain` 可显式结束探索。

例如用一个函数选择最多两个父代批次：

```python
from gear.algorithms import ScopedFrontierPolicy, StagedGEPA

def choose_batches(view, random):
    return ScopedFrontierPolicy(batch_count=min(2, view.max_candidates))(view, random)

def build_algorithm():
    return StagedGEPA(batch_size=4, parent_selection_policy=choose_batches)
```

分发包中的 `multi_parent.py` 可用双算法 CLI 检查。重复抽到同一父代/题族时，当前确定性诊断不会重复生成同一个假设；未使用额度不自动转移给其他批次，排除原因保存在 decision 中。每个父代诊断只读取冻结历史与自身 probe，前一批的新标签或其他准备结果不会进入后一批采样。每批只额外保存 cutoff 和派生元数据摘要，避免按父代数量复制整套题目元数据。重叠 local scopes 的同一父代 baseline 槽位只报价一次，再为候选 local 评测和完整 seed 扩展保留余量。

生成前会给 local baseline、候选评测与完整 seed 扩展预留保守余量；bridge 规划按实际缺失的观察槽位计算整组开销，并保留可能胜者的后续扩展预算。最终物理预算、receipt、取消和恢复仍由 runtime 管理。当前状态标识为 `staged-gepa-v3`，不能装载 v1/v2、默认 recipe 或历史 GEPA 的状态；旧运行继续用其冻结 runtime。中断后运行层复用已经提交的整个决策。无效生成消耗一次候选额度，不会重发。完整 seed 尚未覆盖的候选不能进入最终排名。

默认 `EpochPolicy()` 复用同一 scope。需要周期更新时，在 factory 中使用 `StagedGEPA(epoch_policy=EpochPolicy(update_every_rounds=2, max_historical_specialists=1))`，并从 `gear.algorithms` 导入 `EpochPolicy`。这里的 round 是 recipe 内的生成批次计数，不是物理任务尝试或 worker step。每个 epoch 的共享成功题输入只冻结一次；不会因批次父代变更而在相同 epoch 内重采样。

周期边界先从旧 archive 冻结父代，再为各可用题族生成新 scope。champion 与从该旧 scope 选出的父代是必需参与者；额外历史候选按前沿概率排序，预算不足时从末尾移除可选项。新 scope 的全体参与者都有完整且通过 guard 的 baseline 后才登记；不足或缺失时保留旧 epoch。同一旧 scope 选出的所有父代都属于必需参与者。新 scope 可用于当前已选父代的后续诊断，但不会重抽当前父代，下一批才从更新后的 archive 抽样。参与者、排除理由、开销和 scope manifest 与 evaluate 操作原子写入 decision；Python 不另建证据数据库。父代冻结、周期准备、局部计划分别位于 `stage_parents.py`、`stage_planning.py`、`stage_locals.py`；catalog/只读投影在 `stage_catalog.py`，阶段执行在 `staged.py`。

`scope_frontier` 是独立的公开纯函数，消费已验证 profile 的整数比较键；它计算逐题前沿、合并相同 Target 的代表、移除联合冗余候选、区分 pending 和 guard 拒绝，并混合 outcome/process 权重。`FrontierParentPolicy` 是当前 pass-rate 视图的适配器，只使用完整 seed；候选的 `content_digest` 由 runtime 提供，只传内容身份，不传源码。缺少这个可选字段时不会推测两个候选相同。高级 archive 的证据修订、scope 等价合并和历史来源仍需由可信执行层核验。

多 scope 作者可先用 `project_seed_archive(view, scopes, registrations)` 将已观察的 seed pass scores 投影成 archive。`scopes` 是 `ArchiveScope` 元组，包含 ID、题族、epoch、任务与归一化权重；可选 `registrations` 限定每个 scope 已纳入哪些候选。局部评分完整的候选可以成为该 scope 的父代，但这不使它获得完整 seed 的提名资格。缺失评分保持缺失，默认局部选题也不再把缺失当作失败。must-pass guard 可通过 `must_pass_guards={scope_id: task_ids}` 显式传入，scope 的 guard 身份必须匹配 `gear.algorithms.gepa.research.must_pass_guard_identity(task_ids)`，所有 guard 题必须在 scope 内且实际评分为 1。其他 guard、process 或 objective 仍需可信运行层验证的 profile，再调用 `build_research_archive`。

`build_research_archive` 选择每个题族最新的可用 epoch：新 epoch 证据不完整时保留旧版；相同任务、权重与 guard 身份的 scope 只计算一次概率，不因改名或增加 epoch 而重复增权。候选实例身份与 Target 内容身份分开，内容相同的候选保留原实例引用，但不重复占据前沿。输入只能包含 seed 与已经解决修订冲突的 profile；函数拒绝身份变化、越界任务及冲突的有效评分。它不持有原始证据、revision journal 或外部执行状态。

`parent_input(archive, max_candidates, random_seed, include_champion=True)` 返回类型化父代视图。`ScopedFrontierPolicy(batch_count=...)` 按 scope/frontier 分配候选额度；`ChampionGepaPolicy(champion_probability=...)` 混合已验证 champion 与探索父代。它们的签名是 `(ParentInput, RandomSource) -> ParentPlan`，不能直接作为 `GEPA(parent_policy=...)` 的单参数回调。分发包中的 `examples/python-algorithm/archive_policy.py` 展示如何构建题族 scopes、取得单个分配并返回候选 ID；可运行：

```sh
python -m gear algorithm test archive_policy:build_algorithm --source ./examples/python-algorithm
```

`ParentPlan` 保留完整父代概率、scope/父代引用、slots、draw index 与 reason codes；`validate_parent_plan` 核验范围和配额。`RandomSource.choice(distribution, index=...)` 无可变随机游标，返回选择、完整分布、索引和新 canonical 输入摘要。新算法默认按 UTF-16 ID 排序；比较历史决策时必须显式冻结旧排序。公开 `parent_batches(view, plan, round_id)` 验证并按原顺序展开全部 allocation；运行层继续持久化作者返回的 decision，并独立执行预算校验。

`test-contracts/gepa-archive-v1.json` 的 11 组 archive 与 55 份分配计划由未修改的旧 TypeScript 实现生成，双语言分别比较固定结果。该包示例也通过真实 Python worker 接入运行层，完成生成、完整 seed、最终 gate 和终态恢复。`gepa-epochs-v1.json` 另有 13 组冻结 proposal 的旧 epoch 准入样例，覆盖普通/repair 预算、必需参与者、可选项剔除、缓存、等价和周期边界；不把这份准入 fixture 当作完整采样序列等价。`gepa-parent-batches-v1.json` 另有 55 份旧实现的完整批次展开结果；周期 recipe 已验证多父代、各自采样截止点、旧 scope 保留和准备阶段断线恢复。历史证据修订与跨运行来源、完整诊断、process/objective、regression proposal 与默认流程切换仍未完成。

`select_bridge` 接收已经冻结题族顺序的 nominees，并返回共同计划和 quota/capacity/budget 排除记录；预算回调只报价，不发起执行。`test-contracts/gepa-stages-v1.json` 固定了旧实现的 10 组 frontier 和 10 组 bridge 输出，包含重复 Target、量化平局、缺失 process、guard、轮换、缓存与额度不足。旧 JavaScript 的 locale 排序由 fixture 显式冻结；新 recipe 采用跨平台固定的 UTF-16 ID 顺序，不读取宿主 locale。此 recipe 是新版本流程，默认 `algorithm: gepa` 未切换；跨 run archive 与证据修订、process/objective 执行、完整诊断和 regression proposal 尚待完整迁移。

整套算法也只需实现公开 `SearchAlgorithm` 协议，返回 `Decision(state, operations, reason)`。`Operation` 支持 `diagnose_seed`、`generate`、`evaluate_seed`、`nominate`、`stop`；`nominate` 是提名，不能自行写 champion。最终 `paired-pass-rate-v1` gate 先要求完整 seed 改善，再要求 held-out 不退步；自定义算法也不能绕过，seed 未改善时不消耗 held-out 预算。`SearchView` 只含 seed ID、已观察评分及不含原始内容的证据引用、候选、预算、题族和固定随机种子。不得把任意路径塞进操作；runtime 校验任务范围、候选数量、同组完整证据和预算。

`generate` 可用 `Operation(..., diagnosis_id=receipt_id)` 绑定 `view.completed` 中同一父代的已提交诊断。默认 GEPA 已显式绑定；未指定时，runtime 在生成预留写入前选定最新匹配回执，并将引用一同保存。成功和无效候选的完成记录保留该引用；恢复只核对原生成，不重新选择诊断。协议能力增加 `generation_diagnosis_binding: receipt-v1`，不匹配的 worker 在导入用户算法之前拒绝请求。进程内 TypeScript 算法也只收到 view/state 的独立副本，返回 decision 再复制后才校验、持久化，不能通过修改输入伪造已提交证据。

诊断策略核有独立的公开合同：`failure_clusters` 接收已经认证的 `DiagnosisDossier`，只将有证据引用、机制、假设和修改路径的 `supported-hypothesis` 合并成失败族，不从失败分数推断根因。成功对照按同题族、同原始分层或修改路径交集关联；优先级为受保护失败、失败任务数、明确的冻结顺序。`FailureCluster.sampling_diagnosis()` 可将标签交给既有采样器。旧 locale 次序需显式提供；默认新顺序为 UTF-16。

`plan_hypotheses` 按额度选择并以父代/题族/假设去重；`candidate_workplan` 固定候选、批次、dossier、scope、局部计划、完整 seed 和修改范围。`deliver_workplan` 只交付目标任务与分配 scope 的诊断事实；`consumption_receipt` / `validate_receipt` 校验候选、会话、workplan、dossier、交付摘要和必需引用。`GenerationBudget` 声明 UTC epoch 毫秒截止点及可选 token/request 上限，不执行模型调用或计量。

以上丰富 workplan 尚未接入 StagedGEPA 与真实 Meta 执行。原始证据认证、独立模型诊断及硬预算、实际阅读审计和修改边界执行仍需 runtime/provider 集成；声明已读引用本身不是模型实际消费证据的证明。`gepa-diagnosis-v1.json` 的 10 组旧 TS 固定样例验证纯策略、摘录与回执合同，不证明完整历史 GEPA 等价，也不重写历史身份。

当前 recipe 使用完整 seed baseline、确定性父代选择、失败题局部评测、完整 seed 扩展和一次最终 gate。诊断是已观察 seed 评分投影，不产生隐式额外 LLM 调用；它以稳定操作 ID 持久化，经 `view.completed` 提供给后续策略，并传入 Meta 的生成输入。生成与 seed 评测也记录完成结果。无效候选或已终止但缺少有效输出的 Meta 操作消耗一次生成额度，算法可以据此结束或继续；runtime 不重发同一次生成。同批依赖失败的操作记为 `prerequisite-failed`，不会提交无效 Target。存储或环境故障保持待恢复状态，与候选格式错误分开处理。一个 decision 可包含最多 64 个顺序执行的操作，最终提名或停止只能在末尾。随机策略应只从 `view.random_seed` 推导。`toy_round` 用固定假执行器验证接口，不能代替真实 Target 集成或证明收益。

正式运行冻结代码及依赖身份，把 Python worker 放入断网 sandbox。它看不到 tasks.csv、项目目录、.gear、凭据或 held-out 数据。修改源码、依赖或 profile 后开新 run；已提交 decision 会在 resume 时复用。插件的 stdout 会重定向到 stderr，worker 的 stdout 保留给有版本的 JSON 协议。

高级 TypeScript 消费者通过 `rsi-gear/project` 的 `ProjectApplication` 和 `rsi-gear/project/api` 的端口接入 provider/algorithm；私有状态实现不作为新项目 API 导出。CLI、Python SDK 和项目 Skill 路由共享此应用服务。
