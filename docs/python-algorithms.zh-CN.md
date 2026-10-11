# Python 算法修改入口

`gear.algorithms.GEPA` 是项目接口 v1 的 Python recipe。它显式分阶段返回决策；执行、预算、持久化和最终 gate 归 TypeScript。历史 `failure-cluster-gepa-v2` 保留在原入口，两个版本不会混用恢复状态。

| 想改什么 | 公开入口 | 实现位置 |
| --- | --- | --- |
| 选父代 | `GEPA(parent_policy=fn)` | `gear/algorithms/gepa/parents.py` |
| 选局部题目 | `GEPA(task_sampler=fn)` | `gear/algorithms/gepa/sampling.py` |
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

整套算法也只需实现公开 `SearchAlgorithm` 协议，返回 `Decision(state, operations, reason)`。`Operation` 支持 `diagnose_seed`、`generate`、`evaluate_seed`、`nominate`、`stop`；`nominate` 是提名，不能自行写 champion。最终 `paired-pass-rate-v1` gate 先要求完整 seed 改善，再要求 held-out 不退步；自定义算法也不能绕过，seed 未改善时不消耗 held-out 预算。`SearchView` 只含 seed ID、已观察评分、候选、预算、题族和固定随机种子。不得把任意路径塞进操作；runtime 校验任务范围、候选数量、同组完整证据和预算。

当前 recipe 使用完整 seed baseline、确定性父代选择、失败题局部评测、完整 seed 扩展和一次最终 gate。诊断是已观察 seed 评分投影，不产生隐式额外 LLM 调用；它以稳定操作 ID 持久化，经 `view.completed` 提供给后续策略，并传入 Meta 的生成输入。生成与 seed 评测也记录完成结果。无效候选或已终止但缺少有效输出的 Meta 操作消耗一次生成额度，算法可以据此结束或继续；runtime 不重发同一次生成。同批依赖失败的操作记为 `prerequisite-failed`，不会提交无效 Target。存储或环境故障保持待恢复状态，与候选格式错误分开处理。一个 decision 可包含最多 64 个顺序执行的操作，最终提名或停止只能在末尾。随机策略应只从 `view.random_seed` 推导。`toy_round` 用固定假执行器验证接口，不能代替真实 Target 集成或证明收益。

正式运行冻结代码及依赖身份，把 Python worker 放入断网 sandbox。它看不到 tasks.csv、项目目录、.gear、凭据或 held-out 数据。修改源码、依赖或 profile 后开新 run；已提交 decision 会在 resume 时复用。插件的 stdout 会重定向到 stderr，worker 的 stdout 保留给有版本的 JSON 协议。

高级 TypeScript 消费者通过 `rsi-gear/project` 的 `ProjectApplication` 和 `rsi-gear/project/api` 的端口接入 provider/algorithm；私有状态实现不作为新项目 API 导出。CLI、Python SDK 和项目 Skill 路由共享此应用服务。
