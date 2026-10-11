# Python 算法修改入口

`gear.algorithms.GEPA` 是项目接口 v1 的 Python recipe。它显式分阶段返回决策；执行、预算、持久化和最终 gate 归 TypeScript。历史 `failure-cluster-gepa-v2` 保留在原入口，两个版本不会混用恢复状态。

| 想改什么 | 公开入口 | 实现位置 |
| --- | --- | --- |
| 选父代 | `GEPA(parent_policy=fn)` | `gear/algorithms/gepa/parents.py` |
| 选局部题目 | `GEPA(task_sampler=fn)` | `gear/algorithms/gepa/sampling.py` |
| shared/local/cross 选题 | `GEPA(task_sampler=ScopeSampler(...))` | `gear/algorithms/gepa/scopes.py` |
| 提案计划 | `GEPA(proposal_planner=fn)` | `gear/algorithms/gepa/proposal.py` |
| 排名/提名 | `GEPA(candidate_ranker=fn)` | `gear/algorithms/gepa/ranking.py` |
| 何时停止 | `GEPA(stop_rule=fn)` | `gear/algorithms/gepa/stopping.py` |
| 整个流程 | `SearchAlgorithm.step(view, state)` | `gear/algorithms/gepa/algorithm.py` |

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

保存为 `algorithm/policy.py`，在 gear.yaml 写 `algorithm: {source: ./algorithm, entrypoint: policy:build_algorithm}`。使用 `python -m gear toy` 或直接执行该文件做 CPU toy round，不需要 Node、模型、GPU 或项目数据。

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

这个适配器要求父代的全部 seed 评分已观察到；缺失评分不会当成失败。它选失败最多的题族（并列按 ID 的 UTF-16 顺序），从 `view.random_seed` 确定顺序，用该题族成功题作对照、其他成功题作共享范围，另选跨题族题目。全部通过时返回完整 seed。当前 `SearchView` 没有成本和历史难度，适配器使用成本 1，不推测这些信息。它只替换局部选题，后续仍完整评测 seed，并使用项目 pass-rate gate。

高级策略可使用公开 `gear.algorithms.gepa.scopes` 中的 `SamplingTask`、`FailureFamily`、`ScopeConfig`、`resolve_sizing` 和 `create_scope`，传入已经核验的 seed 元数据，取得 buckets、归一化权重、guard 题目和容量不足原因；`epoch` 控制重采样。这里移植了旧 GEPA 的成功对照、难度/成本分层、模块覆盖、跨题族分配、十进制比例取整及 guard-only 零权重。`ScopeSampler` 只消费返回的任务 ID；完整加权 stage、guard 判定、archive 和 bridge 尚未接入当前 recipe。调用方不能把未验证的历史难度当成运行时证据。

`test-contracts/gepa-scopes-v1.json` 固定了旧 TypeScript 在 10 组输入上的输出；两种语言各自对同一份 fixture 验证语义结果。旧摘要和 run identity 不在此比较范围，Python 不生成旧 run 的身份，也不读取旧状态。这是采样模块的迁移证据，不代表整个历史 GEPA 流程等价。

整套算法也只需实现公开 `SearchAlgorithm` 协议，返回 `Decision(state, operations, reason)`。`Operation` 支持 `diagnose_seed`、`generate`、`evaluate_seed`、`nominate`、`stop`；`nominate` 是提名，不能自行写 champion。最终 `paired-pass-rate-v1` gate 先要求完整 seed 改善，再要求 held-out 不退步；自定义算法也不能绕过，seed 未改善时不消耗 held-out 预算。`SearchView` 只含 seed ID、已观察评分、候选、预算、题族和固定随机种子。不得把任意路径塞进操作；runtime 校验任务范围、候选数量、同组完整证据和预算。

当前 recipe 使用完整 seed baseline、确定性父代选择、失败题局部评测、完整 seed 扩展和一次最终 gate。诊断是已观察 seed 评分投影，不产生隐式额外 LLM 调用；它以稳定操作 ID 持久化，经 `view.completed` 提供给后续策略，并传入 Meta 的生成输入。生成与 seed 评测也记录完成结果。无效候选或已终止但缺少有效输出的 Meta 操作消耗一次生成额度，算法可以据此结束或继续；runtime 不重发同一次生成。同批依赖失败的操作记为 `prerequisite-failed`，不会提交无效 Target。存储或环境故障保持待恢复状态，与候选格式错误分开处理。一个 decision 可包含最多 64 个顺序执行的操作，最终提名或停止只能在末尾。随机策略应只从 `view.random_seed` 推导。`toy_round` 用固定假执行器验证接口，不能代替真实 Target 集成或证明收益。

正式运行冻结代码及依赖身份，把 Python worker 放入断网 sandbox。它看不到 tasks.csv、项目目录、.gear、凭据或 held-out 数据。修改源码、依赖或 profile 后开新 run；已提交 decision 会在 resume 时复用。插件的 stdout 会重定向到 stderr，worker 的 stdout 保留给有版本的 JSON 协议。

高级 TypeScript 消费者通过 `rsi-gear/project` 的 `ProjectApplication` 和 `rsi-gear/project/api` 的端口接入 provider/algorithm；私有状态实现不作为新项目 API 导出。CLI、Python SDK 和项目 Skill 路由共享此应用服务。
