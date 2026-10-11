# 项目重构验证记录

基线：`origin/dev` 的 `9a1281dba7495ea454c637d1bbad4e1605f52db6`。2026-10-11 再次查询远端，dev 仍为此提交。实现分支 `codex/benchmark-refactor`；原工作区和所有 README 保持不变。

## 自动化证据

| 检查 | 结果与边界 |
| --- | --- |
| TypeScript 全量回归 | 101 个测试文件通过，1299 项通过、38 项跳过；无模型环境项单独验证 |
| 最终项目定向回归 | 5 个文件、32 项通过，覆盖取消边界、Meta 视图、相同槽位复用、Git 快照、批量操作、终态生成失败与输入导入 |
| Python 全量回归 | 298 项：294 项通过，4 项按环境跳过 |
| Python 公共 API | Ruff lint/format、Mypy strict 通过 |
| TS 质量 | typecheck、Biome、协议生成一致性、197 个模块依赖/循环检查通过 |
| CI/发布规则 | 14 项规则测试通过；dev 代码变更启用完整回归 |
| 独立 tgz/wheel | 六组 Target/模板组合；check/compile；共享应用 evaluate/refine/report/resume/export；SDK；无 GPU CPU loop 及恢复通过 |
| Python 真实 sandbox | macOS 实测拒绝工作目录之外的私有测试文件、宿主凭据环境变量和已监听的 loopback 端口 |
| Harbor verifier | 三种模板在真实 Docker 容器运行正反例；不安全软链接输出被拒绝；第四项验证输入附件的冻结内容、独立挂载和 inspect 一致性 |
| DSH 固定 carrier | rc.2 的有效 Skill 与完整 Harness 两组原生加载、prompt assembly、Skill 读取检查通过 |
| DSH/Pi 原生行为 | 发布用 runner 在真实 Docker 中各完成一次 Luna 调用；插件/extension 指定输出，经可信评分器得 1；运行后 inspect 一致 |

完整回归之后的终态生成失败处理由最终定向回归和发布包测试覆盖。Linux/macOS CI 已配置真实 worker 隔离门禁；本机实测为 macOS，远端 CI 尚未触发。平台模型测试是显式启用项，不把跳过记为通过。未运行 GPU 训练，也未用自动化代替人工易用性测试。

## 推送后修复

- `paired-pass-rate-v1` 修正最终 gate：先检查 seed 改善，再检查 held-out 不退步；拒绝的 seed 不触发 held-out 试验。32 项运行时测试通过，其中 16 组评分组合与历史 GEPA `decideFinal` 交叉比较，覆盖持平、退步、改善、预算和终态恢复。typecheck 通过。
- 以下 Luna 记录为首批实现的真实运行证据，使用当时冻结的 gate；不能据此声称修正后的门禁已完成模型验收。

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
