## MODIFIED Requirements

### Requirement: Usage and Budget Service

The platform SHALL define a usage and budget service for model tokens, provider cost, tool execution cost, wall-clock time, workflow budgets, session budgets, agent budgets, plugin budgets, and rate-limit telemetry.

平台必须定义 usage and budget service，覆盖 model tokens、provider cost、tool execution cost、wall-clock time、workflow budgets、session budgets、agent budgets、plugin budgets 和 rate-limit telemetry。

#### Scenario: Runtime checks budget before model call

- **WHEN** runtime prepares a model call
- **THEN** it checks token, cost, time, provider, session, workflow, and agent budgets before dispatch

#### Scenario: Tool execution consumes budget

- **WHEN** a capability executes with declared cost or resource usage
- **THEN** the usage service records usage against session, workflow, agent, capability, plugin, and provider dimensions

#### Scenario: Provider token usage is recorded once / Provider Token 用量只入账一次

- **WHEN** runtime receives a provider-normalized model usage event with input tokens, output tokens, cache token metadata, reasoning token metadata, provider identity, model identity, and provider request id
- **THEN** the usage service records the real token totals exactly once for the owning session and exposes those totals to budget checks, diagnostics, scoring, and observability audit evidence
- **AND** the record is linked to the same audit lineage used for the model request without duplicating usage when the event is replayed or rendered in multiple output modes
- **中文** 当 runtime 收到 provider-normalized model usage event，包含 input tokens、output tokens、cache token metadata、reasoning token metadata、provider identity、model identity 与 provider request id 时，usage service 必须为所属 session 将真实 token totals 只记录一次，并将这些 totals 暴露给 budget checks、diagnostics、scoring 与 observability audit evidence；该记录必须关联到 model request 使用的同一条 audit lineage，且在 event replay 或多 output modes 渲染时不得重复入账。

### Requirement: Provider Usage Normalization

Model provider adapters SHALL report normalized usage metadata for input tokens, output tokens, reasoning tokens, cache hit tokens, cache miss tokens, provider name, model name, and provider request id when available.

model provider adapters 必须在可用时报告 normalized usage metadata，包括 input tokens、output tokens、reasoning tokens、cache hit tokens、cache miss tokens、provider name、model name 和 provider request id。

#### Scenario: Missing usage remains explicit

- **WHEN** a provider response completes without usage metadata
- **THEN** the model gateway emits completion events without inventing token counts and tests can assert the absence explicitly

#### Scenario: Audit does not promote estimates to real usage / 审计不把估算提升为真实用量

- **WHEN** prompt assembly or context projection has only estimated tokens before provider dispatch
- **THEN** the usage service may expose estimates as budget planning metadata, but it does not record them as real provider usage until a provider-normalized usage event exists
- **AND** audit records distinguish request estimates, provider-returned usage, and unavailable usage with explicit status fields
- **中文** 当 prompt assembly 或 context projection 在 provider dispatch 前只有 estimated tokens 时，usage service 可以将估算作为 budget planning metadata 暴露，但在 provider-normalized usage event 存在前不得把它记录为真实 provider usage；audit records 必须通过显式 status fields 区分 request estimates、provider-returned usage 与 unavailable usage。
