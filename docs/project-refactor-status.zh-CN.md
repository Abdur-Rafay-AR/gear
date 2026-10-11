# 重构目标与剩余验收

依据 [设计规范](project-refactor-spec.zh-CN.md)、[迁移边界](project-migration.zh-CN.md) 和 [验证记录](project-verification.zh-CN.md)。本表跟踪完整目标，不把一个接口、若干纯函数或一次绿色 CI 当作整项验收完成。日期：2026-10-11。

## 阶段状态

| 阶段 | 已有证据 | 未完成事项 |
| --- | --- | --- |
| M0 基线 | dev 提交、历史身份 fixtures、协议/预算/恢复测试、Target 能力矩阵、依赖检查 | 补齐完整历史 GEPA 决策序列及匹配旧 runtime 的 continuation/rollback 演练 |
| M1 新手闭环 | CSV/JSONL、输入附件、三种模板、check/compile、项目配置、发布包闭环、Luna 实测；Harbor 完整资源导入、静态检查/原样导出及可信 provider 的有界 reward 合同；DSH/Pi Hitch carrier 的真实 Linux 构建、缓存及 Luna 扩展行为 | 任意 Harbor 运行环境的项目 provider、配置与 verifier 隔离执行接入；无 split 时可审阅的按 family 分组方案；setup 认证探测；完整解析计划与提交前预算展示；进阶 scorer/metric 合同 |
| M1b 多 Target | DSH/Pi 原生布局、统一 mutation policy、扩展加载与 Luna 行为评分、相同任务闭环 | 最终默认算法切换后重跑发布产物上的两种 Target 旅程 |
| M2 Python 作者 | 公开策略、完整算法协议、toy/离线 CLI、源码封存、同步/异步 SDK、受限 worker；基础 wheel/CPU training；完整 payload 类型生成和双语言结构校验、响应关联及拒绝合同 | 完整身份/取消错误码与最终发布旅程仍需审计；独立 OneShot 的完整回合及安装后 toy 已补证 |
| M3 默认算法 | scope、frontier、bridge、archive/父代分配与 epoch 准入固定样例；StagedGEPA v4 接入多父代配额、多 scope 父代、持久化 catalog、周期准备、等价去重与准备阶段恢复；完整执行版本难度、诊断元数据与冻结采样截止点；诊断/假设/workplan/回执纯策略及生成引用冻结；独立诊断端口、请求/token 预留结算、seed 评分日志来源认证和预算耗尽收尾；诊断后工作计划、范围限定交付、冻结恢复与增删改边界执行 | 原生 DSH/Pi 的模型请求前硬限制与可信实际用量采集；原始 verifier、重复槽位与 objective 证据认证；真实模型消费审计与生成计量；历史证据修订与跨运行 archive 生命周期、regression proposals、process/objective；完整 shadow/replay、差异说明和默认切换 |
| M4 执行层 | baseline/修复/提交状态、Hitch wire/transport/执行合同已拆，提交/恢复/取消复用独立 execution client 与最小上下文；capabilities 辅助职责已拆；训练唯一实现 | service/evaluator/capabilities 的剩余编排拆分、根 types 分域、provider 能力归拢、存储原语与训练公共类型边界审计 |
| M5 收尾 | 新入口、双语言入门、发布包与 CI 检查；兼容转发保留 | schema/help/样例一致性；配置迁移 dry-run/字段映射；迁移回退演练；旧入口收拢至 compat；完成下表全部验收 |

## 验收状态

“部分”表示已有实现和证据，但规范要求尚未全部覆盖；“人工待验收”不会用自动化代填。

| ID | 状态 | 已有证据与缺口 |
| --- | --- | --- |
| U1 | 人工待验收 | 尚无五名真实新用户的 30 分钟实测 |
| U2 | 已验证当前模板 | 文本、JSON、文件三种模板可无代码创建，check 展示规则及正反例；真实 Docker verifier 另有验证 |
| U3 | 部分 | 8 行意图配置与 config explain 已有；还需完整解析计划及逐字段来源 |
| U4 | 部分 | 实际 tgz/wheel 的离线旅程与 Linux/macOS worker 已有；最终产物的 setup/认证和真实执行完整旅程待补 |
| U5 | 已验证当前合同 | 区分有效零分、无效、缺失、未计划任务、环境故障和物理尝试；smoke 不替代完整 baseline |
| U6 | 已验证当前原生 runner | DSH/Pi 使用同一 benchmark 和 Python recipe 完成 Luna 闭环及终态恢复；最终默认切换后需复验 |
| P1 | 人工待验收 | 已有一页入口索引，尚无新开发者 10 分钟定位实测 |
| P2 | 已验证 | 一个 Python 文件替换父代策略；安装包内双 CLI 和离线合同通过，无模型/GPU |
| P3 | 已验证离线运行合同 | 独立 OneShot 通过安装后 toy，真实 Python 协议进程接入 durable runtime 完成 baseline、生成、完整 seed、最终 gate 与终态恢复 |
| P4 | 已验证当前合同 | 源码/依赖进入身份、篡改拒绝、固定输入重放、提交决策恢复；历史 runtime 继续方式见 C4 |
| P5 | 已验证 | 基础 wheel 和 npm 含 gear 四个入口；CPU loop 与恢复、无 GPU 框架导入通过 |
| P6 | 部分 | 唯一 training 实现与旧入口转发通过；匹配旧 runtime 的活跃任务恢复演练仍待补齐 |
| P7 | 已验证当前原生 runner | Pi extension 与 DSH plugin 的可观察行为修改分别经 Luna 和可信评分器验证 |
| C1 | 已验证当前合同 | 预留、未知提交、断线、取消、原子决策及最终 gate 已有故障注入；后续新阶段继续使用同一 runtime |
| C2 | 已验证当前边界 | seed 投影与 operator/meta 视图；真实 OS 拒绝凭据、私有文件和网络；真实容器隔离 verifier |
| C3 | 部分 | gate 16 组、scope 10 组、frontier/bridge 20 组、archive 11 组与 55 份父代分配、epoch 准入 13 组、历史采样元数据 10 组、完整父代批次 55 份及诊断/提案交付 10 组固定比较通过；完整历史决策序列/预算等价尚未完成 |
| C4 | 部分 | 历史身份 fixtures 原样校验，不改旧数据；完整配置迁移、匹配 runtime 继续与回退演练待补 |
| Q1 | 部分 | 新层依赖、运行时环、lint/typecheck 和外部包消费检查通过；完整 wire payload 类型由 schema 生成并在两端结构校验；公共导出约束与遗留模块边界还需收尾 |
| Q2 | 部分 | 当前中英文 quickstart 与发布脚本已更新；最终所有路径和进阶能力应通过同一发布验证 |

## 实施顺序与清理门槛

1. CI 失败，以及预算、隔离、身份、恢复回归始终优先。
2. 完成 M3 的可信 seed 证据视图和完整历史 GEPA 迁移，先固定旧输入/输出，再改默认算法；不以新算法自己生成的期望值证明等价。
3. 推进 M4 的语义拆分，移除被替代的重复实现，检查新的实现闭包；历史摘要规则不改变。
4. 完成 Harbor 导入、Benchmark/Objective/scorer 合同、初始化与迁移工具，复验所有安装路径。
5. 进行最终发布产物验证、迁移/回退演练与人工验收。

旧 `gear-refine`、稳定 TS exports、`gear_training` 和历史格式解析有明确兼容期，保留必要的薄转发及匹配 runtime 支持。清理针对已经无调用的旧实现、重复规则和被替代模块；不能为了清空目录而删除仍受兼容合同约束的入口。所有 README 和原 `/Users/tangyehui/gear` 用户工作区保持不变。
