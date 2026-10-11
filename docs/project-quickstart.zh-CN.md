# 用任务表创建 Benchmark

适用于本分支的 `gear` 项目接口 v1。安装包含本变更的 `rsi-gear` npm 发布包后即可使用，不需要 clone 仓库。发布前使用本分支的 npm pack 产物；当前 registry 的 latest 不一定包含这些命令。`gear-refine` 仍是历史 evolution 的兼容入口。

```sh
npm install -g rsi-gear
gear doctor
gear setup --native pi --model gpt-5.6-luna
gear init my-benchmark --adapter pi --template text
cd my-benchmark
# 编辑 tasks.csv：任务、预期答案、family、seed/held_out
gear benchmark check
gear evaluate --split seed --limit 1
gear refine --rounds 1
gear report
```

这些命令要求 Node 22.19+（或 24+）、Python 3.10+、Git 和运行中的 Docker。`setup` 创建独立 Python 环境、构建随包提供的固定 native runtime，再自动保存镜像内容身份。首次下载与构建可能耗时。模型凭据由运行环境提供，不能放进 Target 或任务表。正式运行前按下文准备凭据。Python 算法还需要当前平台提供受支持的 sandbox；不可用时正式 refine 会拒绝执行。

`--adapter dsh` 使用 DSH 原生 preset/plugin/skill；`--adapter pi` 使用 Pi 原生 AGENTS.md/settings/extensions/skills。创建项目和 `setup --native` 应选择同一 adapter。Target、Meta 的模型与镜像由 profile 固定；修改 profile 后应新建 run，恢复会拒绝身份变化。

## 输入和评分

三套模板 `text`、`json`、`file` 都不需要编写评分代码。任务表支持 CSV 引号、换行和 JSONL，扩展名决定解析方式。

| 列 | 用途 |
| --- | --- |
| id | 唯一任务 ID |
| instruction | Target 实际收到的任务 |
| expected | text/file 的正确文本；json 的预期字段对象 |
| family | 同一来源/题族必须放在同一分区 |
| split | `seed` 或 `held_out` |
| path | 仅 file 模板需要，例如 `/app/result.txt` |
| inputs | 可选输入文件路径，或 JSON 对象：目标文件名 → 表格目录内的源文件路径 |

已有 CSV/JSONL 可以直接导入：`gear init my-benchmark --adapter pi --from /absolute/tasks.csv --template text`。表格及引用的输入文件会复制到新项目，保留原文件；导入仍要求明确的 family 和 split。使用 `--target-profile`、`--meta-profile` 可分别选已配置的 profile。

例如 `inputs` 为 `data.txt` 时，Target 读取 `/app/inputs/data.txt`；JSONL 也可写 `"inputs": {"data.txt": "fixtures/data.txt"}`。输入必须在原表格目录内，不能使用软链接，每个文件最多 1 MiB、每题合计最多 4 MiB。输入字节参与 benchmark 身份，运行使用封存内容。预期答案不会作为输入文件自动交给 Target。

text/file 默认去除首尾空白后比较；json 检查预期字段及其类型，允许额外字段。Target 将结果写到 `/app/answer.txt` 或指定文件，答案只在评分端读取。`benchmark check` 展示每题输入、评分规则和一正一反例；检查格式、分区泄漏和静态 Target 结构，不发起模型调用。`benchmark compile` 导出 Harbor 格式到 `.gear/benchmarks/`；项目的 Docker provider 直接运行同一任务合同并使用等价评分器。

`gear.yaml` 的默认配置只有 8 行。`gear config explain` 展示解析后的配置。预算 `max_evaluations` 是所有候选与最终 gate 的物理 task 尝试上限；generation 由 rounds 上限控制。单题 evaluate 是 smoke；refine 仅复用身份与重复槽位完全相同的已完成证据（包括有效零分），并补齐其余 seed baseline。晋级先要求完整 seed 改善，再要求 held-out 不退步；seed gate 未通过时不执行 held-out，对应评分保持不可用，未安排的题目不计为缺失。held-out 只用于最终 gate，不进入 Meta 或 Python 算法视图。若确实只有一份任务集，显式设置 `validation: {mode: research}`；报告会标注未做独立验证。

## 运行环境与凭据

内置 native runtime 支持 DSH rc.2 和 Pi 0.68.0 的 OpenAI Codex transport。由现有登录工具准备 `DSH_OPENAI_CODEX_ACCESS_B64` 环境变量：它是 `version/access/expires/accountId` 的短期访问凭据 envelope，不包含 refresh token。Gear 已发布的 `assets/hitch-codex-credential-helper.mjs` 可通过现有 `dsh-codex` 凭据存储导出它。凭据必须覆盖 5 分钟任务期限；不要把值写入配置或提交到 Git。此环境引用只传给固定 Target/Meta 容器，Python worker 不接收它。

已有运行环境可以用 `gear setup --profiles profiles.json`。profile 示例：

```json
{
  "default-target": {
    "image": "your-registry/native-runtime@sha256:<actual-image-digest>",
    "command": ["node", "/opt/gear/native/run.mjs", "pi", "{model}"],
    "model": "gpt-5.6-luna",
    "environment": ["DSH_OPENAI_CODEX_ACCESS_B64"]
  },
  "default-meta": {"image": "...", "command": ["..."], "model": "...", "environment": []}
}
```

省略内容是说明占位，不能直接执行。日常用户用 `setup --native` 自动生成这份配置；`GEAR_HOME` 可指定独立环境目录。`doctor` 检查环境变量存在和依赖就绪，不把它当作一次实际模型认证成功。

## 恢复、报告和导出

运行中断的错误包含 `run_id` 和下一条命令。使用 `gear resume RUN_ID` 查询已提交容器；未知结果保留预留预算，不会自动再次计费。更改任务、模型、算法或候选后创建新 run。`gear cancel RUN_ID` 请求取消，恢复时会核对尚未完成的操作。`gear report RUN_ID --view meta` 仅返回 seed 投影；Refine Skill 使用该视图，操作者默认视图包含最终验证结果。CLI 默认展示可读摘要，`--json` 返回稳定的结构化结果供 SDK/脚本使用。`gear report RUN_ID` 分别展示有效零分、评分故障、环境故障和缺失覆盖，缺失结果不补零。`gear export RUN_ID` 导出 champion 快照和报告。

容器在结束后保留以支持恢复；请在所有相关 run 已终止且报告已导出后由操作者清理 `gear-` 容器。不可在未决 operation 上执行容器 prune。

Python SDK 与 CLI 调用同一个应用服务：

```python
from gear import Project
p = Project("my-benchmark")
p.check()
p.evaluate(limit=1)
result = p.refine(rounds=1)
p.report(result["run_id"])
```

算法修改见 [Python 算法入口](python-algorithms.zh-CN.md)，版本边界与回退见 [迁移说明](project-migration.zh-CN.md)。
