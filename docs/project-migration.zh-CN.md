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
