## ADDED Requirements

### Requirement: Workflow Orchestration Provides Dispatch Constraints

Workflow orchestration SHALL provide declarative constraints to the runtime dispatch layer, including allowed capabilities, stage kind, progress capabilities, budget policy, accepted refs, and terminal close policy.

workflow orchestration 必须向 runtime dispatch layer 提供声明式约束，包括 allowed capabilities、stage kind、progress capabilities、budget policy、accepted refs 与 terminal close policy。

#### Scenario: Ready stage constrains dispatch

- **WHEN** a staged workflow has a ready stage
- **THEN** the dispatch layer receives the ready-stage control data before executing any model-requested tool
- **AND** requests outside the allowed or progress capability set are rejected or routed through convergence according to the stage policy
- **中文** 当 staged workflow 存在 ready stage 时，dispatch layer 必须在执行任何模型请求工具前接收 ready-stage control data；allowed 或 progress capability set 之外的请求必须按照 stage policy 被拒绝或路由到 convergence。

### Requirement: Workflow Orchestration Does Not Replace Dispatch

Workflow orchestration SHALL NOT execute tool calls directly or bypass the dispatch layer for model-requested tools.

workflow orchestration 不得直接执行 tool calls，也不得为模型请求工具绕过 dispatch layer。

#### Scenario: Workflow records intent and evidence

- **WHEN** a workflow stage needs tool execution
- **THEN** workflow orchestration records semantic stage intent, dependencies, refs, and acceptance gates
- **AND** dispatch performs preflight, hook checks, kernel invocation, result feedback, and evidence recording
- **中文** 当 workflow stage 需要工具执行时，workflow orchestration 必须记录 semantic stage intent、dependencies、refs 与 acceptance gates；dispatch 负责 preflight、hook checks、kernel invocation、result feedback 与 evidence recording。

### Requirement: Dispatch Batches Preserve Workflow Evidence

Dispatch batches SHALL emit replayable workflow evidence that can advance or block staged workflow progress.

dispatch batches 必须发出可 replay 的 workflow evidence，用于推进或阻塞 staged workflow progress。

#### Scenario: Batch result updates stage progress

- **WHEN** a dispatch batch completes, fails, is rejected, is cancelled, or is abandoned
- **THEN** workflow orchestration receives bounded evidence with batch id, tool-call ids, capability ids, terminal kinds, accepted refs, diagnostics, and convergence decision
- **AND** stage advancement may consume only accepted evidence refs
- **中文** 当 dispatch batch 完成、失败、被拒绝、被取消或被放弃时，workflow orchestration 必须接收包含 batch id、tool-call ids、capability ids、terminal kinds、accepted refs、diagnostics 与 convergence decision 的有界 evidence；stage advancement 只能消费已接受的 evidence refs。

### Requirement: Workflow Recovery Consumes Dispatch Summaries

Workflow orchestration SHALL consume durable dispatch summaries for recovery, replay, and blocked-stage diagnosis.

workflow orchestration 必须消费 durable dispatch summaries，用于 recovery、replay 与 blocked-stage diagnosis。

#### Scenario: Interrupted dispatch can be diagnosed

- **WHEN** a staged workflow resumes after cancellation, timeout, process exit, provider fallback, or dispatch abandonment
- **THEN** workflow recovery reads dispatch summaries to determine completed tool-call ids, quarantined stale results, in-progress ids, last progress marker, and convergence decision
- **AND** it does not treat missing or partial tool results as successful stage evidence
- **中文** 当 staged workflow 在 cancellation、timeout、process exit、provider fallback 或 dispatch abandonment 后恢复时，workflow recovery 必须读取 dispatch summaries，以确定 completed tool-call ids、quarantined stale results、in-progress ids、last progress marker 与 convergence decision；不得把 missing 或 partial tool results 当作成功 stage evidence。

### Requirement: Workflow Recovery Requires Failure Analysis

Workflow orchestration SHALL route failed stages and attempts through failure analysis before allowing repair, rerun, expansion, or model-owned attribution.

workflow orchestration 必须让失败 stage 与 attempt 先经过 failure analysis，然后才允许 repair、rerun、expansion 或 model-owned attribution。

#### Scenario: Failure evidence gates rerun

- **WHEN** a workflow stage or attempt fails and the workflow policy allows another attempt
- **THEN** recovery creates or consumes a failure-analysis record with failure class, attribution candidate, evidence refs, proof status, and next allowed action
- **AND** recovery does not schedule a rerun until the record proves that rerun is useful or identifies the repair/change/verify action that should happen first
- **中文** 当 workflow stage 或 attempt 失败且 workflow policy 允许另一次 attempt 时，recovery 必须创建或消费包含 failure class、attribution candidate、evidence refs、proof status 与 next allowed action 的 failure-analysis record；除非该 record 证明 rerun 有用，或识别出应先执行的 repair/change/verify action，否则 recovery 不得调度 rerun。

#### Scenario: Attempt recovery preserves stage intent

- **WHEN** accepted failure-analysis evidence says the previous attempt failed after source inspection without mutation or test progress
- **THEN** the next attempt is constrained to the accepted next action such as mutation, standard test, bounded blocker, or focused evidence query
- **AND** workflow orchestration does not reset the attempt to unrestricted discovery unless the failure-analysis proof explicitly invalidated the previous evidence
- **中文** 当已接受 failure-analysis evidence 表明上一 attempt 在 source inspection 之后失败且没有 mutation 或 test progress 时，下一 attempt 必须受限于已接受的 next action，例如 mutation、standard test、bounded blocker 或 focused evidence query；除非 failure-analysis proof 明确证明上一轮 evidence 无效，workflow orchestration 不得把 attempt 重置为无限制 discovery。
