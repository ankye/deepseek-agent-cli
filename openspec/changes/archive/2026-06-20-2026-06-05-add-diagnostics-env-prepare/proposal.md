# Add Diagnostics Environment Preparation

## Why

Live engineering evaluations such as SWE-bench Lite need local tools before the agent can prove task execution: Docker daemon, Docker host wiring, Python virtualenvs, benchmark packages, compiler toolchains, and provider credentials. Today those prerequisites are handled manually, so a CLI baseline can fail for infrastructure reasons even when the task itself is simple.

真实工程评测（例如 SWE-bench Lite）需要 agent 在证明任务执行前具备本地工具：Docker daemon、Docker host 连接、Python virtualenv、benchmark package、compiler toolchain 与 provider credential。当前这些前置条件主要靠人工处理，因此 CLI baseline 可能因为基础环境失败，而不是因为任务能力不足。

## What Changes

- Add `deepseek diagnostics env prepare` as a diagnostics environment preparation surface.
- Add a `swe-bench-lite` built-in environment profile that checks Docker, Colima-compatible Docker host wiring, Python venv, SWE-bench package, Rust toolchain, GLM credential reference, and optional Hugging Face token presence.
- Keep the command dry-run by default; require `--execute` before any allowlisted preparation step runs.
- Return structured text, JSON, and JSONL evidence with stable dependency ids, statuses, command plans, executed steps, diagnostics, and redaction metadata.
- Preserve profile extensibility so future live-provider, web, release, and benchmark profiles can share the same prepare model.

- 增加 `deepseek diagnostics env prepare` 作为 diagnostics environment preparation 入口。
- 增加内置 `swe-bench-lite` 环境 profile，用于检查 Docker、Colima 兼容 Docker host 连接、Python venv、SWE-bench package、Rust toolchain、GLM credential reference 与可选 Hugging Face token。
- 命令默认 dry-run；只有显式 `--execute` 才能运行 allowlisted preparation step。
- 以 text、JSON、JSONL 返回结构化证据，包含稳定 dependency id、状态、command plan、执行步骤、diagnostics 与 redaction metadata。
- 保持 profile 可扩展，后续 live-provider、web、release、benchmark profile 可复用同一 prepare model。

## Impact

- Affected specs: `local-readiness`, `cli-diagnostics-release-readiness`.
- Affected code: `src/apps/cli/src/commands/parse.ts`, `src/apps/cli/src/diagnostics/*`, `src/packages/platform-contracts/src/readiness.ts`, CLI diagnostics tests.

- 影响规格：`local-readiness`、`cli-diagnostics-release-readiness`。
- 影响代码：`src/apps/cli/src/commands/parse.ts`、`src/apps/cli/src/diagnostics/*`、`src/packages/platform-contracts/src/readiness.ts`、CLI diagnostics tests。
