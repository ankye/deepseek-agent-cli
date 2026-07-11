# Add SWE-bench Prediction Adapter

## Why

The `swe-bench-lite` environment profile can prepare Docker, Python, the SWE-bench package, and GLM credentials, but the CLI still cannot produce official SWE-bench prediction JSONL records. A live GLM run can solve internal diagnostics tasks, yet official SWE-bench harness execution requires a separate adapter that checks out a benchmark repository, lets the CLI create a patch, extracts `git diff`, and writes `{ instance_id, model_name_or_path, model_patch }`.

`swe-bench-lite` 环境 profile 已能准备 Docker、Python、SWE-bench package 与 GLM credentials，但 CLI 还不能生成官方 SWE-bench prediction JSONL。GLM live run 可以跑通内部 diagnostics tasks，而官方 SWE-bench harness 需要独立 adapter：在 benchmark repo checkout 中运行 CLI、生成 patch、提取 `git diff`，并写出 `{ instance_id, model_name_or_path, model_patch }`。

## What Changes

- Add `diagnostics swe-bench predict` as the first CLI-owned SWE-bench prediction adapter.
- Read a local SWE-bench instance JSON file and a prepared repository checkout.
- Run the selected CLI provider/model in the repository with an explicit all-tools projection when live execution is requested.
- Write official-compatible prediction JSONL with redacted diagnostics and reproducible invocation metadata.
- Extend the live repository execution policy so explicit all-tools live runs may execute workspace-scoped shell/process commands in the active benchmark repository.

- 增加 `diagnostics swe-bench predict` 作为首个 CLI-owned SWE-bench prediction adapter。
- 读取本地 SWE-bench instance JSON 文件与已准备好的 repository checkout。
- 当请求 live execution 时，在 repo 内使用显式 all-tools projection 运行所选 CLI provider/model。
- 写出兼容官方 harness 的 prediction JSONL，并包含脱敏 diagnostics 与可复现 invocation metadata。
- 扩展 live repo execution policy，使显式 all-tools live run 可以在当前 benchmark repo 中执行 workspace-scoped shell/process commands。

## Non-Goals

- Do not claim public SWE-bench Lite leaderboard scores from a single-instance adapter.
- Do not vendor HuggingFace dataset loading into the TypeScript CLI path.
- Do not bypass repository path governance or secret redaction.

- 不从单题 adapter 声称公开 SWE-bench Lite 榜单分。
- 不把 HuggingFace dataset loading 引入 TypeScript CLI 主链路。
- 不绕过 repo path governance 或 secret redaction。
