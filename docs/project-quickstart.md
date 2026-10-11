# Build a benchmark from a task table

The v1 project interface is included in packages built from this branch. Before publication, install the npm pack artifact; registry latest may not contain these commands. Requirements: Node 22.19+ or 24+, Python 3.10+, Git, Docker, a supported algorithm sandbox, and prepared model credentials.

```sh
npm install -g rsi-gear
gear doctor
gear setup --native pi --model gpt-5.6-luna
gear init my-benchmark --adapter pi --template text
cd my-benchmark
# Edit tasks.csv, keeping each family in one partition.
gear benchmark check
gear evaluate --split seed --limit 1
gear refine --rounds 1
gear report
```

Use `--adapter dsh` and `setup --native dsh` for native DSH plugins; Pi uses native extensions. Setup builds the packaged runtime and records its immutable image identity. Prepare the `DSH_OPENAI_CODEX_ACCESS_B64` short-lived credential envelope from your existing DSH Codex login; it contains version/access/expires/accountId, with no refresh token. Keep it out of project files. The bundled `assets/hitch-codex-credential-helper.mjs` can export this envelope. `doctor` checks prerequisites and environment references; only an actual task verifies authentication.

Choose `text`, `json`, or `file` templates. CSV/JSONL rows have id, instruction, expected, family and split (`seed`/`held_out`); file tasks also specify path under `/app`. Text and file comparison trims outer whitespace by default. JSON checks expected fields and types, allowing additional fields. `benchmark check` previews rules and positive/negative fixtures and checks static Target structure. It does not claim native runtime execution. `benchmark compile` exports Harbor tasks; the project Docker provider runs the same task contract directly.

The generated gear.yaml contains 8 lines. `config explain` prints resolved configuration. A smoke evaluation does not complete the seed baseline. Refine evaluates the full seed set and reserves final held-out gate coverage. Promotion requires a seed improvement followed by no held-out regression. A candidate that fails the seed gate does not run held-out tasks; the report leaves their scores unavailable and does not mark unplanned tasks as missing. Algorithm and Meta processes receive only seed information. `validation: {mode: research}` explicitly enables shared-set optimization and labels reports accordingly.

`max_evaluations` limits physical task attempts including baseline and gate; rounds limits generated candidates. Failed or missing observations stay distinct from valid zero scores. On interruption use the returned `run_id` with `gear resume RUN_ID`. Unknown submissions are inspected without automatic resubmission. Changed inputs require a new run. `cancel` requests cancellation; resume reconciles pending work. `export` writes the champion snapshot and report. Containers remain available for recovery; clean them only after all related operations are terminal.

Python uses the same application service:

```python
from gear import Project
p = Project("my-benchmark")
p.check()
result = p.refine(rounds=1)
p.report(result["run_id"])
```

See the [detailed Chinese guide](project-quickstart.zh-CN.md), [algorithm map](python-algorithms.zh-CN.md), and [migration boundaries](project-migration.zh-CN.md).

## Importing task tables and input files

Use `gear init my-benchmark --adapter pi --from /absolute/tasks.csv --template text` to copy an existing CSV/JSONL table and its referenced inputs into a standalone project. Keep explicit family and split assignments. `--target-profile` and `--meta-profile` select configured profiles independently.

The optional `inputs` column accepts a file path or a JSON object mapping destination names to source paths relative to the table directory. For example, `data.txt` is exposed as `/app/inputs/data.txt`; JSONL can use `"inputs": {"data.txt": "fixtures/data.txt"}`. Files must stay inside that directory, with no symlinks, at most 1 MiB each and 4 MiB per task. Frozen bytes participate in benchmark identity. Expected answers remain verifier resources.

CLI output defaults to a readable summary. Add `--json` for the stable SDK/script response. Invalid candidate proposals consume their generation attempt and are recorded separately from invalid evaluation evidence; an interrupted submitted operation is inspected before any further work.
