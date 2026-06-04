# testing-regression Specification

## Purpose
Define testing regression requirements for deterministic fakes, contracts, integration, golden, matrix, e2e, live opt-in, and governance evidence.

定义 testing regression 对 deterministic fakes、contracts、integration、golden、matrix、e2e、live opt-in 与 governance evidence 的要求。
## Requirements
### Requirement: Deterministic Test Infrastructure

The framework SHALL provide deterministic fakes for protocol, runtime message bus, runtime dependencies, model gateway, workflow, concurrency, platform, workspace state, session store, memory/cache, credentials, usage, policy, sandbox, code intelligence, extension/plugin/skill/hook/MCP loading, and clocks.

框架必须为 protocol、runtime message bus、runtime dependencies、model gateway、workflow、concurrency、platform、workspace state、session store、memory/cache、credentials、usage、policy、sandbox、code intelligence、extension/plugin/skill/hook/MCP loading 和 clocks 提供 deterministic fakes。

#### Scenario: Runtime test does not require live provider

- **WHEN** runtime tests execute a turn
- **THEN** they can use deterministic fake dependencies without live model credentials, real filesystem mutations, or host UI

### Requirement: Contract and Type Tests

The testing regression framework SHALL include contract tests for platform contracts, runtime events, execution envelopes, model gateway streams, tool feedback DTOs, command manifests, and public schema versioning.

testing regression framework 必须包含 platform contracts、runtime events、execution envelopes、model gateway streams、tool feedback DTOs、command manifests 和 public schema versioning 的 contract tests。

#### Scenario: Contract test validates DTO shape

- **WHEN** a public contract is added or changed
- **THEN** a contract test verifies required ids, schema version, redaction metadata, and typed error behavior

#### Scenario: Live tool feedback contract is covered / Live 工具反馈契约被覆盖

- **WHEN** live tool feedback DTOs or event payloads are introduced or changed
- **THEN** contract tests verify schema versioning, bounded previews, redaction metadata, normalized status, trace ids, and provider-neutral shape
- **中文** 当 live tool feedback DTOs 或 event payloads 被引入或修改时，contract tests 必须验证 schema versioning、bounded previews、redaction metadata、normalized status、trace ids 和 provider-neutral shape。

### Requirement: Golden Trace Replay

The testing regression framework SHALL support golden trace replay for deterministic runtime, model gateway, tool loop, scheduler, policy, sandbox, and host rendering behavior.

testing regression framework 必须支持 deterministic runtime、model gateway、tool loop、scheduler、policy、sandbox 和 host rendering behavior 的 golden trace replay。

#### Scenario: Replay validates event order

- **WHEN** a deterministic scenario is replayed
- **THEN** the replay asserts stable event ordering, stable ids when injected, normalized timestamps, and redacted payloads

#### Scenario: Replay validates live tool continuation order / Replay 校验 live 工具继续顺序

- **WHEN** a deterministic live-tool fixture is replayed
- **THEN** the golden trace asserts model request, tool intent, optional repair, governed execution, tool feedback, continuation request, final output, and terminal event ordering
- **中文** 当 deterministic live-tool fixture 被 replay 时，golden trace 必须断言 model request、tool intent、可选 repair、governed execution、tool feedback、continuation request、final output 和 terminal event ordering。

### Requirement: Self-Regression Scenario Suites

The framework SHALL define self-regression scenario suites with stable semantic assertions and optional live-provider suites.

框架必须定义 self-regression scenario suites，使用稳定语义断言，并支持可选 live-provider suites。

#### Scenario: Live provider suite is opt-in

- **WHEN** default regression tests run
- **THEN** they do not call live model providers unless explicitly enabled

#### Scenario: Semantic assertion checks outcome

- **WHEN** a self-regression scenario completes
- **THEN** the harness evaluates declared semantic assertions rather than brittle raw text equality when appropriate

### Requirement: Versioning Regression

The regression system SHALL check version contracts for protocol versions, runtime bus schemas, persisted sessions, golden traces, plugin manifests, extension manifests, capability manifests, command manifests, skill manifests, hook manifests, MCP connector schemas, workspace edit schemas, memory/cache schemas, credential references, usage schemas, distribution metadata, and migration plans.

regression system 必须检查 protocol versions、runtime bus schemas、persisted sessions、golden traces、plugin manifests、extension manifests、capability manifests、command manifests、skill manifests、hook manifests、MCP connector schemas、workspace edit schemas、memory/cache schemas、credential references、usage schemas、distribution metadata 和 migration plans 的版本契约。

#### Scenario: Breaking schema change requires migration

- **WHEN** a persisted schema changes incompatibly
- **THEN** regression fails unless an evolution migration or explicit version rejection path is declared

### Requirement: Test Directory and Ownership Map

The framework SHALL define a test directory and ownership map that separates package-local tests, shared test utilities, contract tests, integration tests, golden traces, scenario suites, versioning fixtures, and CI gates.

框架必须定义 test directory and ownership map，区分 package-local tests、shared test utilities、contract tests、integration tests、golden traces、scenario suites、versioning fixtures 和 CI gates。

#### Scenario: Package owns local unit tests

- **WHEN** a package implements runtime behavior
- **THEN** it owns package-local unit tests under its package test directory using shared fakes only through public contracts

#### Scenario: Cross-package behavior uses integration test area

- **WHEN** a test verifies behavior across protocol, runtime, workflow, concurrency, session, policy, or host adapters
- **THEN** it lives in the shared integration test area and imports packages through public exports

### Requirement: Test Framework Directory Layout

The repository SHALL reserve a test framework layout for `src/packages/testing-regression`, `tests/contracts`, `tests/integration`, `tests/golden`, `tests/scenarios`, `tests/versioning`, `tests/fixtures`, `tests/matrix`, and `tests/e2e`.

repository 必须预留 test framework layout，包含 `src/packages/testing-regression`、`tests/contracts`、`tests/integration`、`tests/golden`、`tests/scenarios`、`tests/versioning`、`tests/fixtures`、`tests/matrix` 和 `tests/e2e`。

#### Scenario: Golden trace has stable location

- **WHEN** a protocol, bus, runtime, workflow, or session golden trace is recorded
- **THEN** it is stored under `tests/golden` with schema version, fixture id, redaction metadata, and nondeterministic field declarations

#### Scenario: Scenario suite has stable location

- **WHEN** a self-regression scenario is added
- **THEN** it is stored under `tests/scenarios` with input, expected semantic assertions, required fakes, allowed nondeterminism, and replay metadata

### Requirement: Test Data Governance

The testing framework SHALL govern fixtures, golden traces, snapshots, recordings, and generated artifacts with schema version, provenance, redaction class, update policy, and review requirements.

testing framework 必须治理 fixtures、golden traces、snapshots、recordings 和 generated artifacts，并包含 schema version、provenance、redaction class、update policy 和 review requirements。

#### Scenario: Golden update requires explicit workflow

- **WHEN** a golden trace or versioning fixture changes
- **THEN** the update must be explicit, reviewed, redacted, and tied to a contract/evolution decision

#### Scenario: Secret is blocked from test artifact

- **WHEN** a fixture, trace, snapshot, recording, or artifact contains raw credentials or secrets
- **THEN** the test framework rejects or redacts it before it can be committed as a regression artifact

### Requirement: Test Matrix and CI Gates

The testing framework SHALL define CI gates for type checks, lint, unit tests, contract tests, integration tests, golden replay, versioning checks, platform matrix tests, host adapter smoke tests, and optional live-provider tests.

testing framework 必须定义 CI gates，覆盖 type checks、lint、unit tests、contract tests、integration tests、golden replay、versioning checks、platform matrix tests、host adapter smoke tests 和 optional live-provider tests。

#### Scenario: Default CI avoids live providers

- **WHEN** default CI runs
- **THEN** it uses deterministic fakes and does not require live model providers, real plugin marketplaces, real MCP servers, real credentials, network access, or real editor hosts

#### Scenario: Platform matrix uses fake adapters first

- **WHEN** platform matrix tests run in default CI
- **THEN** they use fake macOS, Windows, Linux, filesystem, process, shell, and clock adapters before optional real OS suites

### Requirement: Test Harness APIs

The testing-regression package SHALL expose harness APIs for fake dependency assembly, trace normalization, replay execution, semantic assertions, versioning checks, fake clock control, fake platform matrix execution, and artifact redaction.

`testing-regression` package 必须暴露 harness APIs，支持 fake dependency assembly、trace normalization、replay execution、semantic assertions、versioning checks、fake clock control、fake platform matrix execution 和 artifact redaction。

#### Scenario: Runtime smoke test uses harness

- **WHEN** the minimal run smoke test runs
- **THEN** it constructs runtime dependencies through the test harness, records normalized protocol/bus/runtime/session events, and replays them through the regression harness

#### Scenario: Host adapter smoke test uses harness

- **WHEN** CLI or VSCode host adapter smoke tests run
- **THEN** they use protocol fixtures and fake runtime transports rather than live runtime internals or stdout parsing

### Requirement: Test Promotion Ladder

The framework SHALL define a promotion ladder from unit tests to contract tests, integration tests, golden replay, scenario suites, matrix tests, e2e smoke tests, and optional live suites.

框架必须定义 test promotion ladder，从 unit tests 到 contract tests、integration tests、golden replay、scenario suites、matrix tests、e2e smoke tests 和 optional live suites。

#### Scenario: Bug fix adds appropriate regression level

- **WHEN** a bug is fixed
- **THEN** the regression level is selected by blast radius: package-local unit test for local logic, contract test for boundary behavior, golden trace for event sequence, scenario suite for workflow behavior, or matrix test for platform behavior

### Requirement: Execution Governance Regression

The regression harness SHALL capture and replay governed execution envelopes, policy decisions, approval decisions, scheduler events, bus records, audit summaries, outputs, errors, cancellations, retries, and rollback markers.

regression harness 必须捕获并回放 governed execution envelopes、policy decisions、approval decisions、scheduler events、bus records、audit summaries、outputs、errors、cancellations、retries 和 rollback markers。

#### Scenario: Direct execution bypass is tested

- **WHEN** architecture lint is run
- **THEN** regression tests prove direct governed primitive calls outside approved owners, tests, deterministic fakes, or owning packages fail with stable rule ids

#### Scenario: Governed replay compares decisions

- **WHEN** a governed capability scenario is replayed
- **THEN** the harness compares normalized invocation metadata, policy decisions, scheduler decisions, events, results, and redacted failures without live external services

### Requirement: Runtime Kernel Test Matrix

The test framework SHALL include contract, integration, e2e, regression, and lint tests for the runtime execution kernel.

测试框架必须包含 runtime execution kernel 的 contract、integration、e2e、regression 和 lint tests。

#### Scenario: Contract tests cover kernel interfaces

- **WHEN** contract tests run
- **THEN** they validate kernel construction, envelope validation, registry lookup, scheduler task handles, message bus events, and policy decisions

#### Scenario: Integration tests cover full invocation path

- **WHEN** integration tests invoke the deterministic built-in capability
- **THEN** they assert registry, envelope, workflow, policy, scheduler, bus, execution, result, and replay metadata are connected

#### Scenario: E2E tests cover CLI host adapter

- **WHEN** e2e tests run the CLI kernel-backed command
- **THEN** the command exits successfully and outputs events or results derived from the runtime event stream

### Requirement: Runtime Kernel Regression Replay

The regression harness SHALL capture and compare normalized kernel invocation traces.

regression harness 必须捕获并比较 normalized kernel invocation traces。

#### Scenario: Golden replay detects event drift

- **WHEN** a golden kernel invocation is replayed
- **THEN** normalized envelopes, policy decisions, scheduler events, bus events, outputs, terminal results, and audit summaries match the expected trace

### Requirement: Hardening Regression Tests

The test framework SHALL include hardening regression tests for runtime kernel single-entry execution, abort cancellation, timeout, scheduler event order, strict envelope validation, registry projection immutability, event persistence failure, direct bypass lint, and legacy path lint.

测试框架必须包含 runtime kernel single-entry execution、abort cancellation、timeout、scheduler event order、strict envelope validation、registry projection immutability、event persistence failure、direct bypass lint 和 legacy path lint 的 hardening regression tests。

#### Scenario: Reviewed risks have tests

- **WHEN** a hardening risk is identified during architecture review
- **THEN** a unit, contract, integration, e2e, golden, or lint test exists that fails if the risk regresses

#### Scenario: Tests catch issue before review

- **WHEN** code reintroduces direct legacy execution, shallow envelope validation, missing abort propagation, missing scheduler stream events, mutable projections, or swallowed bus failures
- **THEN** the default test or lint suite fails without relying on manual review

### Requirement: Kernel Event Golden Order

Golden replay SHALL cover strict runtime kernel event order including scheduler events and terminal workflow closure.

Golden replay 必须覆盖 strict runtime kernel event order，包括 scheduler events 和 terminal workflow closure。

#### Scenario: Golden event order includes scheduler states

- **WHEN** a deterministic built-in capability is replayed
- **THEN** normalized events match the expected order from request accepted through scheduler queued, scheduler started, capability terminal event, scheduler terminal event, and workflow closed

### Requirement: Deterministic Provider Regression

The testing framework SHALL include deterministic DeepSeek provider fixtures and tests for request construction, text normalization, reasoning normalization, tool-call normalization, usage/cache normalization, provider errors, missing credentials, missing transport, and no default network access.

测试框架必须包含 deterministic DeepSeek provider fixtures 和 tests，覆盖 request construction、text normalization、reasoning normalization、tool-call normalization、usage/cache normalization、provider errors、missing credentials、missing transport 和 no default network access。

#### Scenario: Provider tests use fake transport

- **WHEN** default tests exercise the DeepSeek provider
- **THEN** they use injected fake transport fixtures and never require a live DeepSeek API key or network access

#### Scenario: Golden provider trace is stable

- **WHEN** a DeepSeek provider fixture is replayed
- **THEN** normalized model events match a stable golden trace except for declared nondeterministic provider ids when present

#### Scenario: Lint covers provider boundaries

- **WHEN** architecture lint runs
- **THEN** it includes negative tests for direct credential access and direct governed execution from provider code

### Requirement: Roadmap Regression Levels / 路线图回归等级

The testing framework SHALL require every roadmap node to declare the minimum regression level needed for implementation and launch.

测试框架必须要求每个 roadmap node 声明 implementation 和 launch 所需的 minimum regression level。

#### Scenario: Node declares test ladder / 节点声明测试阶梯

- **WHEN** a roadmap node is planned
- **THEN** it declares required unit, contract, integration, golden, e2e, matrix, versioning, and optional live-provider tests
- **中文** 当规划路线图节点时，必须声明必需的 unit、contract、integration、golden、e2e、matrix、versioning 和可选 live-provider 测试。

#### Scenario: Product node adds scenario coverage / 产品节点增加场景覆盖

- **WHEN** a node introduces user-visible product workflow
- **THEN** a scenario or e2e smoke test covers the host-visible workflow before beta launch
- **中文** 当节点引入用户可见产品流程时，必须在 beta 发布前用 scenario 或 e2e smoke test 覆盖 host 可见流程。

#### Scenario: Readiness and governance fixtures are declared / 声明可用性与治理 fixtures

- **WHEN** a roadmap node includes local readiness, credentials, observability/privacy, code intelligence, SDK/API, or model capability governance
- **THEN** it declares fixtures for no-live-provider execution, redacted diagnostics, credential references, versioning schemas, fallback decisions, and deterministic replay as applicable
- **中文** 当路线图节点包含 local readiness、credentials、observability/privacy、code intelligence、SDK/API 或 model capability governance 时，必须按需声明 no-live-provider execution、redacted diagnostics、credential references、versioning schemas、fallback decisions 和 deterministic replay fixtures。

### Requirement: Optional Live Provider Test Gate / 可选 Live Provider 测试门禁

The testing regression framework SHALL keep live provider tests skipped by default and runnable only through explicit environment flags, credential availability, and bounded structural assertions.

testing regression framework 必须让 live provider tests 默认跳过，仅能通过显式环境变量、credential availability 和有界 structural assertions 运行。

#### Scenario: Live test skipped by default

- **WHEN** default test suites run without live flags
- **THEN** live DeepSeek provider, auth, agent-loop, and tool-loop tests are skipped without making network requests

#### Scenario: Live tool test asserts structure / Live 工具测试断言结构

- **WHEN** `DEEPSEEK_LIVE_AGENT_TOOL_TESTS=1` is set with credentials
- **THEN** the live test asserts provider reachability, tool-call intent structure, runtime event order, redaction, terminal status, and bounded feedback without snapshotting exact model prose
- **中文** 当设置 `DEEPSEEK_LIVE_AGENT_TOOL_TESTS=1` 且 credentials 可用时，live test 必须断言 provider reachability、tool-call intent structure、runtime event order、redaction、terminal status 和 bounded feedback，且不得 snapshot 精确模型文本。

### Requirement: Local Readiness Regression / 本地可用性回归

The testing framework SHALL include deterministic unit, contract, integration, and CLI smoke tests for R1 local readiness commands.

testing framework 必须为 R1 local readiness commands 提供 deterministic unit、contract、integration 和 CLI smoke tests。

#### Scenario: Readiness smoke covers all commands / readiness smoke 覆盖所有命令

- **WHEN** readiness smoke tests run
- **THEN** init, config, auth, doctor, privacy, and verify-install commands complete without live provider access and emit structured redacted results
- **中文** 当 readiness smoke tests 运行时，init、config、auth、doctor、privacy 和 verify-install commands 必须在不访问 live provider 的情况下完成，并输出 structured redacted results。

#### Scenario: Secret fixture is not leaked / secret fixture 不泄漏

- **WHEN** tests provide fake DeepSeek credentials
- **THEN** stdout, JSON output, traces, snapshots, and assertion messages contain only redacted references and never raw secret values
- **中文** 当 tests 提供 fake DeepSeek credentials 时，stdout、JSON output、traces、snapshots 和 assertion messages 只能包含 redacted references，绝不能包含 raw secret values。

### Requirement: Persistent Config And Auth Regression / 持久化配置与认证回归

The testing framework SHALL include deterministic unit, contract, integration, e2e, matrix, versioning, redaction, and optional live tests for persistent config and credential reference behavior.

testing framework 必须为 persistent config 和 credential reference behavior 提供 deterministic unit、contract、integration、e2e、matrix、versioning、redaction 和 optional live tests。

#### Scenario: Config precedence is tested / 配置优先级被测试

- **WHEN** tests provide defaults, user config, workspace config, environment values, and CLI overrides for the same key
- **THEN** the regression suite proves the resolved value follows the required precedence and records source metadata for winning and shadowed values
- **中文** 当 tests 为同一 key 提供 defaults、user config、workspace config、environment values 和 CLI overrides 时，regression suite 必须证明 resolved value 遵循要求的优先级，并记录 winning 和 shadowed values 的 source metadata。

#### Scenario: Credential redaction is tested across outputs / 凭证脱敏跨输出测试

- **WHEN** tests store fake DeepSeek credentials and run auth, config, doctor, live verification fakes, traces, snapshots, and assertion paths
- **THEN** raw fake credentials never appear in stdout, JSON, command results, runtime events, model events, logs, snapshots, or assertion messages
- **中文** 当 tests 存储 fake DeepSeek credentials 并运行 auth、config、doctor、live verification fakes、traces、snapshots 和 assertion paths 时，raw fake credentials 绝不能出现在 stdout、JSON、command results、runtime events、model events、logs、snapshots 或 assertion messages 中。

### Requirement: Persistence Matrix Regression / 持久化矩阵回归

The testing framework SHALL cover config and credential-adjacent persistence behavior across fake Windows, macOS, Linux, read-only filesystem, partial-write failure, missing secure storage, and corrupted config scenarios.

testing framework 必须覆盖 fake Windows、macOS、Linux、read-only filesystem、partial-write failure、missing secure storage 和 corrupted config scenarios 下的 config 与 credential-adjacent persistence behavior。

#### Scenario: Platform paths are matrix tested / 平台路径经过矩阵测试

- **WHEN** matrix tests run for config and auth persistence
- **THEN** they verify user config paths, workspace metadata paths, path normalization, traversal rejection, permission diagnostics, and atomic write behavior across fake platform adapters
- **中文** 当 config 和 auth persistence 的 matrix tests 运行时，必须跨 fake platform adapters 验证 user config paths、workspace metadata paths、path normalization、traversal rejection、permission diagnostics 和 atomic write behavior。

#### Scenario: Corrupted config fails safely / 损坏配置安全失败

- **WHEN** a persisted config document is corrupted, incompatible, partially written, or contains secret-like values
- **THEN** tests prove commands return structured diagnostics and do not silently use unsafe values
- **中文** 当 persisted config document 损坏、不兼容、部分写入或包含 secret-like values 时，tests 必须证明 commands 返回 structured diagnostics，且不会静默使用 unsafe values。

### Requirement: Optional Live Auth Verification Gate / 可选 Live Auth 验证门禁

The testing framework SHALL keep real `doctor --live` or equivalent DeepSeek verification outside default tests and expose it through an explicit script and environment gate.

testing framework 必须把真实 `doctor --live` 或等价 DeepSeek verification 排除在默认测试之外，并通过显式脚本和环境门禁暴露。

#### Scenario: Default tests remain offline / 默认测试保持离线

- **WHEN** `npm test`, `npm run lint`, `npm run typecheck`, and default e2e tests run
- **THEN** they do not require network access, account balance, real credentials, OS keychain access, or provider availability
- **中文** 当 `npm test`、`npm run lint`、`npm run typecheck` 和默认 e2e tests 运行时，不得要求 network access、account balance、real credentials、OS keychain access 或 provider availability。

#### Scenario: Live auth smoke is structural / live auth smoke 是结构化断言

- **WHEN** optional live auth verification runs with explicit credentials
- **THEN** it asserts provider-neutral structure, redacted credential handling, non-empty terminal response metadata, and typed failure semantics without snapshotting exact generated model text
- **中文** 当 optional live auth verification 使用显式 credentials 运行时，必须断言 provider-neutral structure、redacted credential handling、non-empty terminal response metadata 和 typed failure semantics，且不 snapshot 精确生成模型文本。

### Requirement: Expanded Platform Matrix Regression / 扩展平台矩阵回归

The testing framework SHALL include deterministic fake platform matrix coverage for macOS, Windows, Linux, WSL, CI/no-native, and remote/no-local-shell modes.

testing framework 必须为 macOS、Windows、Linux、WSL、CI/no-native 和 remote/no-local-shell modes 提供 deterministic fake platform matrix coverage。

#### Scenario: Matrix covers degraded hosts / 矩阵覆盖降级 host

- **WHEN** matrix tests run
- **THEN** they cover hosts with unavailable native features, unavailable secure storage, unavailable shell, and provider fallback behavior
- **中文** 当 matrix tests 运行时，必须覆盖 native features unavailable、secure storage unavailable、shell unavailable 和 provider fallback behavior 的 host。

### Requirement: Platform Bypass Lint Regression / 平台绕过 Lint 回归

The testing framework SHALL include architecture lint regression tests that reject direct OS branching, direct process execution, direct search binary invocation, direct secure-storage access, and direct native capability loading outside approved platform-owner packages.

testing framework 必须包含 architecture lint regression tests，拒绝 approved platform-owner packages 之外的 direct OS branching、direct process execution、direct search binary invocation、direct secure-storage access 和 direct native capability loading。

#### Scenario: Direct platform primitive fails lint / 直接平台 primitive 触发 lint

- **WHEN** a non-owner package imports process execution, OS detection, search binaries, secure storage APIs, or native modules directly
- **THEN** lint fails with stable rule ids and actionable messages
- **中文** 当非 owner package 直接 import process execution、OS detection、search binaries、secure storage APIs 或 native modules 时，lint 必须以 stable rule ids 和 actionable messages 失败。

### Requirement: Fail-Closed Platform Fixtures / 平台 Fail-Closed Fixtures

The testing framework SHALL provide fixtures for unsupported paths, unsafe path traversal, missing shell, missing search provider, missing native capability, missing secure storage, and WSL path translation.

testing framework 必须提供 unsupported paths、unsafe path traversal、missing shell、missing search provider、missing native capability、missing secure storage 和 WSL path translation 的 fixtures。

#### Scenario: Review finding becomes regression / Review finding 变为回归测试

- **WHEN** a platform boundary bug is found during review
- **THEN** a matrix or lint regression test is added before the change can be archived
- **中文** 当 review 中发现 platform boundary bug 时，必须在 archive 前增加 matrix 或 lint regression test。

### Requirement: Core Coding Tool Regression Suite / 核心 Coding Tool 回归套件

The testing framework SHALL include deterministic unit, contract, integration, golden, matrix, and e2e tests for core coding tools.

testing framework 必须为 core coding tools 提供 deterministic unit、contract、integration、golden、matrix 和 e2e tests。

#### Scenario: Minimal coding turn is covered / 最小 coding turn 被覆盖

- **WHEN** core tool regression tests run
- **THEN** they cover reading a fixture file, applying an exact edit, running a deterministic test command, and returning structured evidence through runtime events
- **中文** 当 core tool regression tests 运行时，必须覆盖读取 fixture file、应用 exact edit、运行 deterministic test command，并通过 runtime events 返回 structured evidence。

#### Scenario: Platform matrix covers core tools / 平台矩阵覆盖核心工具

- **WHEN** matrix tests run
- **THEN** read, edit, search, shell/test unavailable behavior, path rejection, provider fallback, and output bounding are covered across fake macOS, Windows, Linux, WSL, CI, and remote hosts
- **中文** 当 matrix tests 运行时，必须跨 fake macOS、Windows、Linux、WSL、CI 和 remote hosts 覆盖 read、edit、search、shell/test unavailable behavior、path rejection、provider fallback 和 output bounding。

#### Scenario: Architecture lint blocks bypass / 架构 lint 阻止绕过

- **WHEN** core tool implementation or a future package attempts direct filesystem, process, search binary, or platform primitive access outside approved owner packages
- **THEN** architecture lint fails with stable rule ids
- **中文** 当 core tool implementation 或未来 package 尝试在 approved owner packages 外直接访问 filesystem、process、search binary 或 platform primitive 时，architecture lint 必须以 stable rule ids 失败。

### Requirement: Minimal Chat CLI Regression / 最小 Chat CLI 回归

The testing framework SHALL include deterministic unit, integration, golden, e2e, and lint coverage for the minimal chat CLI.

testing framework 必须为 minimal chat CLI 提供 deterministic unit、integration、golden、e2e 和 lint 覆盖。

#### Scenario: Chat unit tests cover parser and controls / Chat 单测覆盖解析与控制

- **WHEN** package-local CLI tests run
- **THEN** they cover chat command parsing, plain prompt detection, help output, unknown command errors, exit behavior, and non-TTY no-arg behavior
- **中文** 当 package-local CLI tests 运行时，必须覆盖 chat command parsing、plain prompt detection、help output、unknown command errors、exit behavior 和 non-TTY no-arg behavior。

#### Scenario: Chat integration test uses runtime events / Chat 集成测试使用 runtime events

- **WHEN** integration tests run a scripted chat prompt
- **THEN** assertions prove the output is derived from kernel-backed runtime events and not from a separate CLI execution state machine
- **中文** 当 integration tests 运行脚本化 chat prompt 时，assertions 必须证明输出来自 kernel-backed runtime events，而不是单独的 CLI execution state machine。

#### Scenario: Chat e2e covers prompt, help, cancel, and exit / Chat e2e 覆盖 prompt、help、cancel 与 exit

- **WHEN** e2e tests execute the CLI chat shell with deterministic scripted input
- **THEN** prompt submission, `/help`, `/cancel`, `/exit` or EOF complete without live provider access and without raw secret output
- **中文** 当 e2e tests 使用确定性脚本输入执行 CLI chat shell 时，prompt submission、`/help`、`/cancel`、`/exit` 或 EOF 必须在不访问 live provider 且不输出 raw secret 的情况下完成。

### Requirement: Chat Golden Replay / Chat Golden Replay

The regression harness SHALL capture and replay normalized minimal chat CLI traces.

regression harness 必须捕获并回放 normalized minimal chat CLI traces。

#### Scenario: Golden trace proves run parity / golden trace 证明 run parity

- **WHEN** a minimal prompt is executed through chat mode and run mode with deterministic fakes
- **THEN** normalized runtime event semantics match except for declared host input/output wrapper events
- **中文** 当使用 deterministic fakes 分别通过 chat mode 与 run mode 执行最小 prompt 时，normalized runtime event semantics 必须匹配，除了声明过的 host input/output wrapper events。

#### Scenario: Golden trace covers cancellation / golden trace 覆盖取消

- **WHEN** an active chat turn is cancelled in a deterministic fixture
- **THEN** the replayed trace includes request correlation, cancellation control, terminal cancellation or structured failure event, and runtime shutdown evidence
- **中文** 当 active chat turn 在 deterministic fixture 中被取消时，replayed trace 必须包含 request correlation、cancellation control、terminal cancellation 或 structured failure event，以及 runtime shutdown evidence。

### Requirement: Chat Architecture Lint / Chat 架构 Lint

Architecture lint SHALL prevent the chat CLI from bypassing governed runtime, command, policy, platform, or capability boundaries.

architecture lint 必须防止 chat CLI 绕过 governed runtime、command、policy、platform 或 capability boundaries。

#### Scenario: Chat bypass fails lint / Chat 绕过触发 lint

- **WHEN** CLI chat code directly invokes model providers, core tool executors, policy internals, scheduler internals, sandbox internals, platform primitives outside approved host adapter APIs, or app-to-app imports
- **THEN** lint fails with stable rule ids before default tests pass
- **中文** 当 CLI chat code 直接调用 model providers、core tool executors、policy internals、scheduler internals、sandbox internals、approved host adapter APIs 之外的 platform primitives，或 app-to-app imports 时，lint 必须在默认测试通过前以 stable rule ids 失败。

### Requirement: Session Resume/Fork Regression / Session Resume/Fork 回归

The testing framework SHALL include deterministic contract, integration, golden, versioning, matrix where applicable, and e2e coverage for session resume and fork-lite.

testing framework 必须为 session resume 与 fork-lite 提供 deterministic contract、integration、golden、versioning、适用时的 matrix 和 e2e 覆盖。

#### Scenario: Contract tests cover store semantics / 合同测试覆盖 store 语义

- **WHEN** session-store contract tests run
- **THEN** they cover create, append, resume, fork-lite, lineage metadata, unknown session failure, redaction, and serialization for all supported deterministic stores
- **中文** 当 session-store contract tests 运行时，必须覆盖所有 supported deterministic stores 的 create、append、resume、fork-lite、lineage metadata、unknown session failure、redaction 和 serialization。

#### Scenario: Integration tests cover resumed runtime turn / 集成测试覆盖恢复后的 runtime turn

- **WHEN** integration tests submit a prompt after resume or fork-lite
- **THEN** runtime events use the selected session id and still include governed kernel, policy, scheduler, bus, and workflow evidence
- **中文** 当 integration tests 在 resume 或 fork-lite 后提交 prompt 时，runtime events 必须使用选定 session id，并仍包含 governed kernel、policy、scheduler、bus 和 workflow evidence。

#### Scenario: E2E tests cover CLI session commands / E2E 覆盖 CLI session 命令

- **WHEN** e2e tests run CLI session resume/fork commands
- **THEN** they complete with deterministic fakes, structured output, no live provider access, and no raw secret output
- **中文** 当 e2e tests 运行 CLI session resume/fork commands 时，必须使用 deterministic fakes 完成，输出 structured output，不访问 live provider，且不输出 raw secret。

### Requirement: Session Resume/Fork Golden Replay / Session Resume/Fork Golden Replay

The regression harness SHALL capture and replay normalized session resume and fork-lite traces.

regression harness 必须捕获并回放 normalized session resume 与 fork-lite traces。

#### Scenario: Golden replay covers resume / Golden replay 覆盖 resume

- **WHEN** a resumed session trace is replayed
- **THEN** normalized events include original session events, resume metadata, subsequent runtime events, and stable event ordering
- **中文** 当 resumed session trace 被 replay 时，normalized events 必须包含 original session events、resume metadata、subsequent runtime events 和 stable event ordering。

#### Scenario: Golden replay covers fork-lite / Golden replay 覆盖 fork-lite

- **WHEN** a forked session trace is replayed
- **THEN** normalized events include parent lineage, fork event, child session id, child runtime events, and replayable redacted metadata
- **中文** 当 forked session trace 被 replay 时，normalized events 必须包含 parent lineage、fork event、child session id、child runtime events 和 replayable redacted metadata。

### Requirement: Session Versioning Fixtures / Session 版本契约 Fixtures

The testing framework SHALL include versioning fixtures for persisted session metadata, resume results, fork results, and unknown schema rejection.

testing framework 必须包含 persisted session metadata、resume results、fork results 和 unknown schema rejection 的 versioning fixtures。

#### Scenario: Persisted schema is required / Persisted schema 必须存在

- **WHEN** persisted session metadata, resume result, or fork result lacks a schema version
- **THEN** versioning tests fail with a deterministic diagnostic
- **中文** 当 persisted session metadata、resume result 或 fork result 缺少 schema version 时，versioning tests 必须以 deterministic diagnostic 失败。

#### Scenario: Unsupported schema fails closed / 不支持的 schema 安全失败

- **WHEN** session persistence contains an unsupported schema version
- **THEN** resume/fork tests prove the system returns a typed versioning failure instead of silently accepting incompatible state
- **中文** 当 session persistence 包含 unsupported schema version 时，resume/fork tests 必须证明系统返回 typed versioning failure，而不是静默接受 incompatible state。

### Requirement: Context Projection Regression Suite / Context Projection 回归套件

The testing framework SHALL include deterministic unit, contract, integration, golden, versioning, matrix, and e2e coverage for ContextGraph projection.

testing framework 必须为 ContextGraph projection 提供 deterministic unit、contract、integration、golden、versioning、matrix 和 e2e 覆盖。

#### Scenario: Contract tests cover projection DTOs / 合同测试覆盖 Projection DTO

- **WHEN** projection contract tests run
- **THEN** they verify schema versions, serializability, fake substitutability, redaction metadata, budget metadata, and no implementation imports in `platform-contracts`
- **中文** 当 projection contract tests 运行时，必须验证 schema versions、serializability、fake substitutability、redaction metadata、budget metadata，以及 `platform-contracts` 不导入实现包。

#### Scenario: Integration tests cover runtime projection / 集成测试覆盖 Runtime Projection

- **WHEN** runtime integration tests dispatch a model turn
- **THEN** they prove projection runs before provider request construction and model gateway receives only projected context
- **中文** 当 runtime integration tests 派发 model turn 时，必须证明 projection 在 provider request construction 前运行，且 model gateway 只收到 projected context。

### Requirement: Projection Golden Replay / Projection Golden Replay

Golden replay SHALL capture selected nodes, excluded nodes, budget decisions, cache metadata, redaction summaries, and projection terminal state.

golden replay 必须捕获 selected nodes、excluded nodes、budget decisions、cache metadata、redaction summaries 和 projection terminal state。

#### Scenario: Replay detects projection drift / Replay 检测 Projection 漂移

- **WHEN** projection ranking, filtering, redaction, cache, or budget behavior changes
- **THEN** golden replay detects the semantic drift unless the fixture is explicitly updated
- **中文** 当 projection ranking、filtering、redaction、cache 或 budget 行为变化时，golden replay 必须检测 semantic drift，除非 fixture 被显式更新。

### Requirement: Projection Versioning Fixtures / Projection 版本契约 Fixtures

The testing framework SHALL include versioning fixtures for projection request, result, event, and cache metadata schemas.

testing framework 必须包含 projection request、result、event 和 cache metadata schemas 的 versioning fixtures。

#### Scenario: Unsupported projection schema fails closed / 不支持的 Projection Schema 安全失败

- **WHEN** persisted or replayed projection evidence uses an unsupported schema version
- **THEN** versioning tests prove the system returns a typed versioning failure instead of silently accepting incompatible state
- **中文** 当 persisted 或 replayed projection evidence 使用 unsupported schema version 时，versioning tests 必须证明系统返回 typed versioning failure，而不是静默接受 incompatible state。

### Requirement: Projection Matrix Fixtures / Projection 矩阵 Fixtures

Projection regression SHALL cover empty context, large session, stale cache, secret fixture, hard budget exceeded, memory unavailable, and degraded host scope.

projection regression 必须覆盖 empty context、large session、stale cache、secret fixture、hard budget exceeded、memory unavailable 和 degraded host scope。

#### Scenario: Secret fixture does not leak / Secret Fixture 不泄漏

- **WHEN** projection tests include secret-like context nodes
- **THEN** stdout, JSON, traces, snapshots, cache artifacts, golden fixtures, and assertion messages contain only redacted evidence
- **中文** 当 projection tests 包含 secret-like context nodes 时，stdout、JSON、traces、snapshots、cache artifacts、golden fixtures 和 assertion messages 只能包含 redacted evidence。

### Requirement: Secret And Sandbox Regression Suite / Secret 与 Sandbox 回归套件

The testing framework SHALL include deterministic unit, contract, integration, golden, versioning, matrix, lint, and e2e coverage for secret and sandbox hardening.

testing framework 必须为 secret 与 sandbox hardening 提供 deterministic unit、contract、integration、golden、versioning、matrix、lint 和 e2e 覆盖。

#### Scenario: Secret fixtures never leak / Secret Fixtures 绝不泄漏

- **WHEN** tests run with API keys, bearer tokens, private key blocks, env-style credentials, or secret redaction classes
- **THEN** stdout, JSONL, traces, sessions, caches, snapshots, golden files, and assertion messages contain only redacted evidence
- **中文** 当 tests 使用 API keys、bearer tokens、private key blocks、env-style credentials 或 secret redaction classes 时，stdout、JSONL、traces、sessions、caches、snapshots、golden files 和 assertion messages 只能包含 redacted evidence。

#### Scenario: Sandbox matrix covers platform modes / Sandbox 矩阵覆盖平台模式

- **WHEN** sandbox matrix tests run
- **THEN** they cover fake Windows, macOS, Linux, WSL, remote/no-shell, read-only filesystem, missing secure storage, missing network, and missing native capability modes
- **中文** 当 sandbox matrix tests 运行时，必须覆盖 fake Windows、macOS、Linux、WSL、remote/no-shell、read-only filesystem、missing secure storage、missing network 和 missing native capability modes。

### Requirement: Secret And Sandbox Bypass Lint / Secret 与 Sandbox 绕过 Lint

Architecture lint SHALL reject direct secret, environment, filesystem, process, native, or sandbox primitive access outside approved owner packages and tests.

architecture lint 必须拒绝 approved owner packages 与 tests 之外的 direct secret、environment、filesystem、process、native 或 sandbox primitive access。

#### Scenario: Host bypass fails lint / Host 绕过触发 Lint

- **WHEN** CLI, VSCode, provider, plugin, or feature packages read raw environment secrets, execute processes, mutate files, or select sandbox profiles directly
- **THEN** lint fails with stable rule ids before default tests pass
- **中文** 当 CLI、VSCode、provider、plugin 或 feature packages 直接读取 raw environment secrets、执行 processes、修改 files 或选择 sandbox profiles 时，lint 必须在默认测试通过前以 stable rule ids 失败。

### Requirement: Checkpoint Undo Regression Coverage / Checkpoint Undo 回归覆盖

The regression framework SHALL include deterministic unit, contract, integration, golden, and matrix coverage for checkpoint creation, restore, undo, stale rejection, and secret-safe evidence.

regression framework 必须为 checkpoint creation、restore、undo、stale rejection 和 secret-safe evidence 提供确定性的 unit、contract、integration、golden 和 matrix 覆盖。

#### Scenario: Golden replay covers undo / golden replay 覆盖 undo

- **WHEN** a replay fixture applies a file mutation and then undoes it
- **THEN** replay asserts stable checkpoint ids, restore status, hashes, diagnostics, and redaction fields without raw file content
- **中文** 当 replay fixture 应用 file mutation 后再 undo 时，replay 必须断言稳定的 checkpoint ids、restore status、hashes、diagnostics 和 redaction fields，且不包含 raw file content。

#### Scenario: Matrix covers stale restore rejection / matrix 覆盖 stale restore 拒绝

- **WHEN** fake platform modes modify the file after checkpoint creation
- **THEN** restore is rejected consistently and does not overwrite the newer content
- **中文** 当 fake platform modes 在 checkpoint 创建后修改文件时，restore 必须一致地拒绝，且不得覆盖较新的内容。

### Requirement: Code Intelligence Regression Coverage / 代码智能回归覆盖

The regression framework SHALL cover code intelligence local analyzer behavior with unit, contract, integration, golden, and matrix tests that do not require a live IDE, LSP server, or external network.

regression framework 必须用 unit、contract、integration、golden 和 matrix tests 覆盖 code intelligence local analyzer 行为，且不要求 live IDE、LSP server 或外部网络。

#### Scenario: Golden replay includes code evidence / golden replay 包含代码证据

- **WHEN** a golden trace includes diagnostic or symbol context nodes
- **THEN** replay asserts stable schema, redaction, provider metadata, and no raw secret-like content
- **中文** 当 golden trace 包含 diagnostic 或 symbol context nodes 时，replay 必须断言稳定 schema、redaction、provider metadata，以及没有 raw secret-like content。

### Requirement: Observability Privacy Regression Coverage / 观测隐私回归覆盖

The regression framework SHALL include deterministic unit, contract, integration, golden, versioning, and matrix coverage for observability records, privacy settings, export decisions, diagnostic bundles, and no-raw-secret evidence.

regression framework 必须为 observability records、privacy settings、export decisions、diagnostic bundles 和 no-raw-secret evidence 提供 deterministic unit、contract、integration、golden、versioning 和 matrix 覆盖。

#### Scenario: Golden replay includes observability evidence / golden replay 包含观测证据

- **WHEN** a golden trace includes runtime events and observability records
- **THEN** replay asserts stable schema, privacy decision metadata, redaction summary, and no raw secret-like content
- **中文** 当 golden trace 包含 runtime events 与 observability records 时，replay 必须断言 stable schema、privacy decision metadata、redaction summary 和无 raw secret-like content。

#### Scenario: Matrix covers privacy modes / matrix 覆盖隐私模式

- **WHEN** matrix tests run
- **THEN** they cover default local diagnostics, telemetry disabled, external export denied, explicit local bundle generation, and secret fixtures
- **中文** 当 matrix tests 运行时，必须覆盖 default local diagnostics、telemetry disabled、external export denied、explicit local bundle generation 和 secret fixtures。

#### Scenario: Versioning requires schemas / versioning 要求 schema

- **WHEN** versioning tests inspect observability records and diagnostic bundles
- **THEN** missing or unsupported schema versions fail closed with deterministic diagnostics
- **中文** 当 versioning tests 检查 observability records 与 diagnostic bundles 时，missing 或 unsupported schema versions 必须以 deterministic diagnostics 安全失败。

### Requirement: Skill System Regression Coverage / Skill System 回归覆盖

The regression framework SHALL include deterministic unit, contract, integration, golden, versioning, and matrix coverage for skills v1 without requiring live plugins, external catalogs, network access, or host-specific APIs.

regression framework 必须为 skills v1 提供 deterministic unit、contract、integration、golden、versioning 和 matrix 覆盖，且不要求 live plugins、external catalogs、network access 或 host-specific APIs。

#### Scenario: Golden replay includes skill activation / golden replay 包含 skill activation

- **WHEN** a golden trace includes trusted skill activation and context segment projection
- **THEN** replay asserts stable manifest schema, loading metadata, context segment fingerprints, redaction metadata, and no raw secret-like content
- **中文** 当 golden trace 包含 trusted skill activation 与 context segment projection 时，replay 必须断言 stable manifest schema、loading metadata、context segment fingerprints、redaction metadata 和无 raw secret-like content。

#### Scenario: Matrix covers trust and loading modes / matrix 覆盖 trust 与 loading modes

- **WHEN** matrix tests run
- **THEN** they cover trusted built-in skills, untrusted workspace skills, disabled skills, malformed manifests, summary-only listing, explicit activation, and bounded projection
- **中文** 当 matrix tests 运行时，必须覆盖 trusted built-in skills、untrusted workspace skills、disabled skills、malformed manifests、summary-only listing、explicit activation 和 bounded projection。

#### Scenario: Versioning requires skill schemas / versioning 要求 skill schemas

- **WHEN** versioning tests inspect skill manifests, activation results, summaries, or context segments
- **THEN** missing or unsupported schema versions fail closed with deterministic diagnostics
- **中文** 当 versioning tests 检查 skill manifests、activation results、summaries 或 context segments 时，missing 或 unsupported schema versions 必须以 deterministic diagnostics 安全失败。

### Requirement: Hook System Regression Coverage / Hook System 回归覆盖

The regression framework SHALL include deterministic unit, contract, integration, golden, versioning, matrix, and lint coverage for hooks v1 without requiring live plugins, external marketplaces, network access, host-specific APIs, or nondeterministic timers.

regression framework 必须为 hooks v1 提供 deterministic unit、contract、integration、golden、versioning、matrix 和 lint 覆盖，且不要求 live plugins、external marketplaces、network access、host-specific APIs 或 nondeterministic timers。

#### Scenario: Golden replay includes hook invocation / golden replay 包含 hook invocation

- **WHEN** a golden trace includes hook validation, order projection, invocation, output records, and failure policy evidence
- **THEN** replay asserts stable schema versions, ordered hook ids, terminal status, output kinds, diagnostics, redaction metadata, and replay fingerprints
- **中文** 当 golden trace 包含 hook validation、order projection、invocation、output records 和 failure policy evidence 时，replay 必须断言 stable schema versions、ordered hook ids、terminal status、output kinds、diagnostics、redaction metadata 和 replay fingerprints。

#### Scenario: Matrix covers ordering and failure modes / matrix 覆盖 ordering 与 failure modes

- **WHEN** matrix tests run
- **THEN** they cover trusted built-in hooks, untrusted workspace hooks, disabled hooks, malformed manifests, stable ordering, continue, block, disable, rollback-requested, timeout, and observe-only output modes
- **中文** 当 matrix tests 运行时，必须覆盖 trusted built-in hooks、untrusted workspace hooks、disabled hooks、malformed manifests、stable ordering、continue、block、disable、rollback-requested、timeout 和 observe-only output modes。

#### Scenario: Versioning requires hook schemas / versioning 要求 hook schemas

- **WHEN** versioning tests inspect hook manifests, summaries, invocation requests, invocation results, output records, or diagnostics
- **THEN** missing or unsupported schema versions fail closed with deterministic diagnostics
- **中文** 当 versioning tests 检查 hook manifests、summaries、invocation requests、invocation results、output records 或 diagnostics 时，missing 或 unsupported schema versions 必须以 deterministic diagnostics 安全失败。

#### Scenario: Lint rejects legacy hook APIs / lint 拒绝旧 hook APIs

- **WHEN** hook contracts or implementations reintroduce generic `register` or `run` APIs
- **THEN** architecture lint fails with a stable hook-system rule id
- **中文** 当 hook contracts 或 implementations 重新引入泛化 `register` 或 `run` APIs 时，architecture lint 必须以稳定的 hook-system rule id 失败。

### Requirement: MCP Gateway Regression Coverage / MCP Gateway 回归覆盖

The regression framework SHALL include deterministic unit, contract, integration, golden, versioning, matrix, and lint coverage for MCP gateway v1 without requiring real MCP servers, network access, process spawning, live credentials, plugin marketplaces, or host-specific APIs.

regression framework 必须为 MCP gateway v1 提供 deterministic unit、contract、integration、golden、versioning、matrix 和 lint 覆盖，且不要求 real MCP servers、network access、process spawning、live credentials、plugin marketplaces 或 host-specific APIs。

#### Scenario: Golden replay includes MCP invocation / golden replay 包含 MCP invocation

- **WHEN** a golden trace includes MCP server connection, tool discovery, tool invocation, resource read, prompt listing, and failure isolation evidence
- **THEN** replay asserts stable schema versions, server ids, namespace, target ids, terminal status, diagnostics, redaction metadata, and replay fingerprints
- **中文** 当 golden trace 包含 MCP server connection、tool discovery、tool invocation、resource read、prompt listing 和 failure isolation evidence 时，replay 必须断言 stable schema versions、server ids、namespace、target ids、terminal status、diagnostics、redaction metadata 和 replay fingerprints。

#### Scenario: Matrix covers trust and transport modes / matrix 覆盖 trust 与 transport modes

- **WHEN** matrix tests run
- **THEN** they cover trusted fake server, workspace server, untrusted server, disabled server, malformed manifest, namespace collision, unsupported schema, unavailable real transport, timeout, unknown tool, unknown resource, and redaction behavior
- **中文** 当 matrix tests 运行时，必须覆盖 trusted fake server、workspace server、untrusted server、disabled server、malformed manifest、namespace collision、unsupported schema、unavailable real transport、timeout、unknown tool、unknown resource 和 redaction behavior。

#### Scenario: Versioning requires MCP schemas / versioning 要求 MCP schemas

- **WHEN** versioning tests inspect MCP manifests, server summaries, tool summaries, resource summaries, prompt summaries, tool call results, resource read results, or diagnostics
- **THEN** missing or unsupported schema versions fail closed with deterministic diagnostics
- **中文** 当 versioning tests 检查 MCP manifests、server summaries、tool summaries、resource summaries、prompt summaries、tool call results、resource read results 或 diagnostics 时，missing 或 unsupported schema versions 必须以 deterministic diagnostics 安全失败。

#### Scenario: Lint rejects legacy MCP APIs / lint 拒绝旧 MCP APIs

- **WHEN** MCP contracts or implementations reintroduce generic pre-v1 APIs
- **THEN** architecture lint fails with a stable MCP gateway rule id
- **中文** 当 MCP contracts 或 implementations 重新引入泛化 pre-v1 APIs 时，architecture lint 必须以稳定 MCP gateway rule id 失败。

### Requirement: Live Tool Platform Matrix Coverage / Live 工具平台矩阵覆盖

The regression suite SHALL include platform matrix coverage for live tool preflight behavior across Windows, macOS, Linux, and fake platforms.

回归套件必须包含 Windows、macOS、Linux 和 fake 平台上 live 工具预检行为的平台矩阵覆盖。

#### Scenario: Matrix covers live tool path repair / Matrix 覆盖 live 工具路径修复

- **WHEN** provider-specific live tool repair touches path-like inputs
- **THEN** matrix tests cover Windows separators, POSIX separators, drive-relative rejection, absolute path rejection, traversal rejection, null-byte rejection, and workspace-relative repair
- **中文** 当 provider-specific live tool repair 处理 path-like inputs 时，matrix tests 必须覆盖 Windows separators、POSIX separators、drive-relative rejection、absolute path rejection、traversal rejection、null-byte rejection 和 workspace-relative repair。

### Requirement: Unsafe Live Tool Regression Cases / 不安全 Live 工具回归用例

The regression suite SHALL include deterministic cases for unsafe live tool calls, including unknown tools, hidden tools, schema-invalid inputs, traversal paths, unsupported platform commands, policy denial, timeout, cancellation, and repeated unsafe retries.

回归套件必须包含不安全 live tool calls 的 deterministic cases，包括 unknown tools、hidden tools、schema-invalid inputs、traversal paths、unsupported platform commands、policy denial、timeout、cancellation 和 repeated unsafe retries。

#### Scenario: Unsafe call never reaches executor / 不安全调用不进入执行器

- **WHEN** a deterministic model fixture emits an unsafe live tool request
- **THEN** tests assert no executor invocation occurred and the emitted events include typed rejection evidence
- **中文** 当 deterministic model fixture 发出 unsafe live tool request 时，测试必须断言 executor 没有被调用，且 emitted events 包含 typed rejection evidence。

#### Scenario: Repeated unsafe calls stop loop / 重复不安全调用停止循环

- **WHEN** a model repeatedly emits unsafe tool calls after corrective feedback
- **THEN** tests assert runtime stops according to loop policy and emits a terminal failure
- **中文** 当模型在 corrective feedback 后重复发出 unsafe tool calls 时，测试必须断言 runtime 按 loop policy 停止，并发出 terminal failure。

### Requirement: Agent Loop Deterministic Tests / Agent Loop 确定性测试

The testing framework SHALL provide deterministic unit and integration fixtures for agent loop success, tool execution, repair, rejection, timeout, cancellation, and provider failure without network access.

testing framework 必须为 agent loop success、tool execution、repair、rejection、timeout、cancellation 和 provider failure 提供无需网络访问的 deterministic unit 与 integration fixtures。

#### Scenario: Offline tool loop test / 离线工具循环测试

- **WHEN** tests run the agent loop with a fake model that requests a file read tool and then returns assistant text
- **THEN** the event sequence, tool result evidence, terminal status, and rendered output match deterministic assertions
- **中文** 当测试使用 fake model 运行 agent loop，且 fake model 请求 file read tool 后返回 assistant text 时，event sequence、tool result evidence、terminal status 和 rendered output 必须匹配确定性断言。

#### Scenario: Unsafe tool request test / 不安全工具请求测试

- **WHEN** tests run the agent loop with a fake model that requests an outside-workspace path or disabled command
- **THEN** the loop rejects the request without mutation and emits typed validation evidence
- **中文** 当测试使用 fake model 运行 agent loop，且 fake model 请求 outside-workspace path 或 disabled command 时，loop 必须拒绝该请求、不产生修改，并发出 typed validation evidence。

### Requirement: Agent Loop Golden Replay / Agent Loop Golden Replay

The testing framework SHALL include golden replay fixtures for canonical agent loop event streams and rendered CLI output.

testing framework 必须为 canonical agent loop event streams 与 rendered CLI output 提供 golden replay fixtures。

#### Scenario: Golden trace catches event drift / Golden trace 捕获事件漂移

- **WHEN** runtime event order, event schema version, redaction metadata, trace correlation, or terminal status changes
- **THEN** golden tests fail unless fixtures are intentionally updated with reviewable evidence
- **中文** 当 runtime event order、event schema version、redaction metadata、trace correlation 或 terminal status 变化时，golden tests 必须失败，除非 fixtures 被有意更新并具备可审查证据。

### Requirement: Agent Loop CLI E2E / Agent Loop CLI E2E

The test suite SHALL include CLI e2e coverage for `deepseek run` and `deepseek chat` using deterministic runtime dependencies.

test suite 必须使用 deterministic runtime dependencies 覆盖 `deepseek run` 与 `deepseek chat` 的 CLI e2e。

#### Scenario: Run command e2e succeeds / Run 命令 e2e 成功

- **WHEN** e2e tests invoke `deepseek run --output json "hello"` with deterministic provider fixtures
- **THEN** the process exits successfully and stdout parses as the expected final JSON summary
- **中文** 当 e2e tests 使用 deterministic provider fixtures 调用 `deepseek run --output json "hello"` 时，进程必须成功退出，且 stdout 可解析为预期 final JSON summary。

#### Scenario: Chat command e2e exits / Chat 命令 e2e 退出

- **WHEN** e2e tests feed one prompt and an exit command into `deepseek chat --output jsonl`
- **THEN** the process emits valid JSONL events and exits without leaving child work running
- **中文** 当 e2e tests 向 `deepseek chat --output jsonl` 输入一个 prompt 和 exit command 时，进程必须发出有效 JSONL events 并退出，且不留下 child work。

### Requirement: Agent Loop Live Smoke Gate / Agent Loop Live Smoke Gate

The test suite SHALL provide opt-in live DeepSeek agent loop smoke tests gated by explicit environment variables and skipped by default.

test suite 必须提供 opt-in live DeepSeek agent loop smoke tests，通过显式环境变量启用，并默认跳过。

#### Scenario: Live smoke is skipped by default / Live smoke 默认跳过

- **WHEN** default tests run without live environment variables
- **THEN** live DeepSeek agent loop smoke tests are skipped with a clear reason and no network request is sent
- **中文** 当默认测试在没有 live 环境变量时运行时，live DeepSeek agent loop smoke tests 必须带明确原因跳过，且不得发送网络请求。

#### Scenario: Live smoke asserts structure / Live smoke 断言结构

- **WHEN** live smoke is explicitly enabled with credentials
- **THEN** tests assert event structure, redaction, terminal status, provider reachability, and optional usage metadata without snapshotting exact generated text
- **中文** 当 live smoke 通过凭证显式启用时，测试必须断言 event structure、redaction、terminal status、provider reachability 和可选 usage metadata，且不 snapshot 精确生成文本。

### Requirement: Reference Pit Regression Harness / 参考坑位回归 Harness

The testing-regression package SHALL expose deterministic helpers for loading, filtering, and asserting reference pit fixture coverage.

`testing-regression` package 必须暴露确定性 helpers，用于加载、筛选和断言 reference pit fixture coverage。

#### Scenario: Harness filters by owner and risk / Harness 按 owner 与风险筛选

- **WHEN** tests request reference pit fixtures by owner package or risk class
- **THEN** the harness returns stable catalog entries with deterministic ordering and no host-specific side effects
- **中文** 当测试按 owner package 或 risk class 请求 reference pit fixtures 时，harness 必须返回排序稳定的 catalog entries，且无 host-specific side effects。

#### Scenario: Harness detects missing coverage ids / Harness 检测缺失覆盖 ID

- **WHEN** a coverage assertion omits a covered or partial fixture id
- **THEN** the harness fails with a deterministic diagnostic naming the missing fixture ids
- **中文** 当 coverage assertion 遗漏 covered 或 partial fixture id 时，harness 必须以确定性 diagnostic 失败，并列出缺失 fixture ids。

### Requirement: Reference Pit Evidence Remains Redacted / 参考坑位证据保持脱敏

Reference pit fixture evidence SHALL avoid raw secrets, raw credentials, copied reference source, and machine-local private paths.

reference pit fixture evidence 必须避免 raw secrets、raw credentials、复制的参考源码和机器本地私有路径。

#### Scenario: Fixture catalog is safe to serialize / Fixture Catalog 可安全序列化

- **WHEN** the reference pit fixture catalog is serialized for diagnostics or tests
- **THEN** it contains only redacted or synthetic values and does not include raw credential material
- **中文** 当 reference pit fixture catalog 为 diagnostics 或 tests 序列化时，它只能包含脱敏或合成值，不得包含 raw credential material。

### Requirement: Approval UX Regression Fixtures / 审批 UX 回归 Fixtures

The testing-regression layer SHALL provide deterministic fixtures and assertions for CLI approval lifecycle parity, headless fail-closed behavior, reference pit fixture coverage, and replayable approval evidence.

testing-regression layer 必须为 CLI approval lifecycle parity、headless fail-closed behavior、reference pit fixture coverage 和 replayable approval evidence 提供确定性 fixtures 与 assertions。

#### Scenario: Approval parity fixture replays / 审批一致性 Fixture 可 Replay

- **WHEN** approval UX golden or contract tests replay a governed invocation requiring approval
- **THEN** text, JSON, JSONL, chat, and run projections preserve equivalent approval id, decision options, denial reason, audit reference, trace metadata, and redaction metadata
- **中文** 当 approval UX golden 或 contract tests replay 一个需要审批的 governed invocation 时，text、JSON、JSONL、chat 和 run projections 必须保留等价的 approval id、decision options、denial reason、audit reference、trace metadata 和 redaction metadata。

#### Scenario: Reference pit ids are asserted / Reference Pit Ids 被断言

- **WHEN** approval tests cover permission bypass, headless trust, shell parser fallback, path canonicalization, extension permission expansion, or diagnostic redaction
- **THEN** the tests cite the corresponding `pit.*` fixture ids and fail if covered or partial pit ids disappear from evidence
- **中文** 当 approval tests 覆盖 permission bypass、headless trust、shell parser fallback、path canonicalization、extension permission expansion 或 diagnostic redaction 时，tests 必须引用对应 `pit.*` fixture ids，并在 covered 或 partial pit ids 从 evidence 消失时失败。

### Requirement: Approval Terminal Matrix / 审批终端矩阵

Approval UX SHALL be tested across deterministic terminal and execution profiles.

approval UX 必须跨确定性 terminal 与 execution profiles 测试。

#### Scenario: Headless matrix fails closed / Headless 矩阵安全失败

- **WHEN** matrix tests run approval-required work across CI, non-TTY, scripted, redirected output, unsupported raw input, and unknown-width profiles
- **THEN** tests prove the behavior is deterministic fail-closed or uses an explicit injected broker decision, with no workspace mutation on default denial
- **中文** 当 matrix tests 在 CI、non-TTY、scripted、redirected output、unsupported raw input 和 unknown-width profiles 中运行需要审批的 work 时，tests 必须证明行为是确定性 fail-closed 或使用显式 injected broker decision，并且默认 denial 不修改 workspace。

### Requirement: CLI Diagnostics Regression / CLI 诊断回归

The testing regression suite SHALL include deterministic coverage for CLI diagnostics bundle, diagnostics release readiness, doctor, privacy, and verify-install outputs.

testing regression suite 必须为 CLI diagnostics bundle、diagnostics release readiness、doctor、privacy 和 verify-install outputs 提供确定性覆盖。

#### Scenario: Diagnostics CLI smoke is deterministic / Diagnostics CLI Smoke 确定性

- **WHEN** CLI diagnostics tests run
- **THEN** they assert text, JSON, and JSONL outputs parse deterministically, contain stable kinds and schema versions, and do not include raw secret-like fixture values
- **中文** 当 CLI diagnostics tests 运行时，必须断言 text、JSON 和 JSONL outputs 可确定性解析，包含稳定 kind 与 schema versions，且不包含 raw secret-like fixture values。

#### Scenario: Release readiness package surface is tested / 发布就绪包表面被测试

- **WHEN** release-readiness tests run
- **THEN** they assert expected CLI package files, bin entry, publish access, ignored generated bundles, and required verification command names
- **中文** 当 release-readiness tests 运行时，必须断言 expected CLI package files、bin entry、publish access、ignored generated bundles 和 required verification command names。

### Requirement: Support Bundle Redaction Regression / 支持包脱敏回归

The regression suite SHALL test full serialization of support-bundle outputs against raw secret, credential, env, plugin, MCP, trace, and path fixture leaks.

regression suite 必须测试 support-bundle outputs 的完整序列化，防止 raw secret、credential、env、plugin、MCP、trace 和 path fixture 泄漏。

#### Scenario: Bundle serialization is safe / Bundle 序列化安全

- **WHEN** support-bundle tests serialize CLI diagnostics bundle output
- **THEN** the serialized output excludes raw secret values and includes `pit.diagnostic-redaction.support-bundle`
- **中文** 当 support-bundle tests 序列化 CLI diagnostics bundle output 时，serialized output 必须排除 raw secret values，并包含 `pit.diagnostic-redaction.support-bundle`。

#### Scenario: External export denial is tested / 外部导出拒绝被测试

- **WHEN** support-upload or external telemetry is requested without explicit export permission
- **THEN** tests assert the privacy decision is `deny-export` and no records are included in the external payload
- **中文** 当在没有显式 export permission 时请求 support-upload 或 external telemetry，测试必须断言 privacy decision 是 `deny-export`，且 external payload 不包含 records。

### Requirement: CLI Extension Management Regression / CLI 扩展管理回归

The regression suite SHALL include deterministic coverage for CLI extension listing, plugin install/apply/snapshot/verify, skill list/activate, credential scope diagnostics, MCP test projection, and text/JSON/JSONL parity.

Regression suite 必须为 CLI extension listing、plugin install/apply/snapshot/verify、skill list/activate、credential scope diagnostics、MCP test projection 和 text/JSON/JSONL parity 提供确定性覆盖。

#### Scenario: Extension CLI smoke is deterministic / 扩展 CLI Smoke 确定
- **WHEN** CLI extension management tests run
- **THEN** they use local manifests, deterministic fakes, fake credentials, and fake/in-process MCP by default without requiring network, live marketplaces, real MCP servers, real credentials, or editor hosts
- **中文** 当 CLI extension management tests 运行时，默认必须使用 local manifests、deterministic fakes、fake credentials 和 fake/in-process MCP，且不要求 network、live marketplaces、real MCP servers、real credentials 或 editor hosts。

#### Scenario: Output parity is tested / 输出一致性被测试
- **WHEN** text, JSON, and JSONL extension outputs are produced for the same fixture
- **THEN** tests assert equivalent target ids, statuses, diagnostics, permission diff counts, credential scope ids, redaction metadata, and reference pit fixture ids
- **中文** 当同一 fixture 产出 text、JSON 和 JSONL extension outputs 时，测试必须断言 target ids、statuses、diagnostics、permission diff counts、credential scope ids、redaction metadata 和 reference pit fixture ids 等价。

### Requirement: Extension Pit Fixture Coverage / 扩展坑位 Fixture 覆盖

Extension management regression SHALL assert reference pit fixture ids for permission expansion, MCP/plugin precedence, immutable env snapshots, diagnostic redaction, and legacy contribution normalization.

Extension management regression 必须断言 permission expansion、MCP/plugin precedence、immutable env snapshots、diagnostic redaction 和 legacy contribution normalization 的 reference pit fixture ids。

#### Scenario: Required pit ids are asserted / 必需坑位 ID 被断言
- **WHEN** extension regression tests serialize evidence
- **THEN** they assert `pit.extension-permission-expansion.permission-diff`, `pit.mcp-plugin-precedence.enterprise-deny`, `pit.env-snapshot.immutable-startup`, `pit.diagnostic-redaction.support-bundle`, and `pit.legacy-contribution-normalization.manifest-boundary` appear in the relevant records
- **中文** 当 extension regression tests 序列化 evidence 时，必须断言相关 records 中出现 `pit.extension-permission-expansion.permission-diff`、`pit.mcp-plugin-precedence.enterprise-deny`、`pit.env-snapshot.immutable-startup`、`pit.diagnostic-redaction.support-bundle` 和 `pit.legacy-contribution-normalization.manifest-boundary`。

#### Scenario: Raw reference source is absent / 原始参考源码不存在
- **WHEN** extension management fixtures or tests are scanned
- **THEN** they contain DeepSeek-owned synthetic manifests and pit ids only, with no copied reference implementation source or tracked `参考/` files
- **中文** 当扫描 extension management fixtures 或 tests 时，它们只能包含 DeepSeek-owned synthetic manifests 和 pit ids，不得包含复制的参考实现源码或 tracked `参考/` files。

### Requirement: Composition Regression Coverage / 组合层回归覆盖

The regression suite SHALL include deterministic coverage for command/skill/hook/MCP/plugin/workflow composition records, projection filters, alias collisions, schema versioning, and no-execution projection.

Regression suite 必须为 command/skill/hook/MCP/plugin/workflow composition records、projection filters、alias collisions、schema versioning 和 no-execution projection 提供确定性覆盖。

#### Scenario: Projection parity is tested / 投影一致性被测试
- **WHEN** composition records are projected for CLI help, chat slash commands, user-visible records, and model-visible records
- **THEN** tests assert stable target ids, ordering, visibility, redaction, diagnostics, and reference pit ids
- **中文** 当 composition records 投影到 CLI help、chat slash commands、user-visible records 和 model-visible records 时，测试必须断言 stable target ids、ordering、visibility、redaction、diagnostics 和 reference pit ids。

#### Scenario: Projection does not execute owners / 投影不执行 Owner
- **WHEN** projection includes records derived from commands, skills, hooks, MCP, plugins, or workflows
- **THEN** tests assert no command handler, skill activation, hook handler, MCP call, plugin lifecycle action, or workflow execution was invoked
- **中文** 当 projection 包含来自 commands、skills、hooks、MCP、plugins 或 workflows 的 records 时，测试必须断言没有调用 command handler、skill activation、hook handler、MCP call、plugin lifecycle action 或 workflow execution。

### Requirement: Composition Pit Fixture Coverage / 组合层坑位 Fixture 覆盖

Composition regression SHALL cite reference pit fixture ids for legacy contribution normalization, MCP/plugin precedence, and extension permission expansion where applicable.

Composition regression 必须在适用处引用 legacy contribution normalization、MCP/plugin precedence 和 extension permission expansion 的 reference pit fixture ids。

#### Scenario: Required composition pit ids are asserted / 必需组合坑位 ID 被断言
- **WHEN** composition tests serialize projection evidence
- **THEN** relevant records include `pit.legacy-contribution-normalization.manifest-boundary`, `pit.mcp-plugin-precedence.enterprise-deny`, or `pit.extension-permission-expansion.permission-diff`
- **中文** 当 composition tests 序列化 projection evidence 时，相关 records 必须包含 `pit.legacy-contribution-normalization.manifest-boundary`、`pit.mcp-plugin-precedence.enterprise-deny` 或 `pit.extension-permission-expansion.permission-diff`。

### Requirement: Palette And Action Regression Coverage / 面板与动作回归覆盖

The regression suite SHALL cover command palette projection, minimal vi keymap mapping, keymap conflict diagnostics, result-list action resolution, jump/reference updates, and no-owner-execution behavior.

Regression suite 必须覆盖 command palette projection、minimal vi keymap mapping、keymap conflict diagnostics、result-list action resolution、jump/reference updates 和不执行 owner 的行为。

#### Scenario: Palette projection parity is tested / 面板投影一致性被测试
- **WHEN** composition records are projected to palette entries and command result lists
- **THEN** tests assert stable ids, ordering, target metadata, source trust, permissions, side effects, redaction, diagnostics, and reference pit fixture ids
- **中文** 当 composition records 投影到 palette entries 和 command result lists 时，测试必须断言 stable ids、ordering、target metadata、source trust、permissions、side effects、redaction、diagnostics 和 reference pit fixture ids。

#### Scenario: Result-list action state is tested / 结果列表动作状态被测试
- **WHEN** result-list navigation or `add-to-reference-set` actions are resolved
- **THEN** tests assert active target changes, result-list focus changes, reference set updates, and jump history updates without workspace mutation
- **中文** 当 result-list navigation 或 `add-to-reference-set` actions 被解析时，测试必须断言 active target changes、result-list focus changes、reference set updates 和 jump history updates，且不修改 workspace。

#### Scenario: Vi profile conflicts are tested / Vi Profile 冲突被测试
- **WHEN** conflicting keymap contributions are validated
- **THEN** tests assert deterministic conflict diagnostics and no silent host-specific override
- **中文** 当 conflicting keymap contributions 被校验时，测试必须断言 deterministic conflict diagnostics，且没有静默 host-specific override。

### Requirement: Scriptable Palette Regression Coverage / 可脚本化 Palette 回归覆盖

The regression suite SHALL cover scriptable CLI palette list, keymap, action resolution, typed failures, structured rendering, and inert/no-owner-execution behavior.

Regression suite 必须覆盖可脚本化 CLI palette list、keymap、action resolution、typed failures、structured rendering 和惰性/不执行 owner 行为。

#### Scenario: CLI palette list is tested / CLI Palette List 被测试
- **WHEN** CLI host tests run `palette list` in JSON and JSONL modes
- **THEN** tests assert stable entries, result-list metadata, reference pit fixture ids, no ANSI controls, and no model/runtime events
- **中文** 当 CLI host tests 以 JSON 与 JSONL 模式运行 `palette list` 时，测试必须断言 stable entries、result-list metadata、reference pit fixture ids、无 ANSI controls 且无 model/runtime events。

#### Scenario: CLI keymap profile is tested / CLI Keymap Profile 被测试
- **WHEN** CLI host tests run `palette keymap vi-minimal`
- **THEN** tests assert vi navigation mappings and deterministic diagnostics
- **中文** 当 CLI host tests 运行 `palette keymap vi-minimal` 时，测试必须断言 vi navigation mappings 与确定性 diagnostics。

#### Scenario: CLI palette action is tested / CLI Palette Action 被测试
- **WHEN** CLI host tests run `palette action`
- **THEN** tests assert typed success and failure results, dry-run descriptors, and no workspace/session mutation
- **中文** 当 CLI host tests 运行 `palette action` 时，测试必须断言 typed success 与 failure results、dry-run descriptors 和无 workspace/session mutation。

### Requirement: Chat Palette Control Regression Coverage / Chat Palette 控制回归覆盖

The regression suite SHALL cover chat-local palette, keymap, and palette action slash controls across text and structured output modes.

Regression suite 必须覆盖 text 与 structured output modes 下的 chat-local palette、keymap 和 palette action slash controls。

#### Scenario: Chat palette controls are tested / Chat Palette Controls 被测试
- **WHEN** CLI host tests run scripted chat input containing `/palette` and `/keymap`
- **THEN** tests assert local output records and no model/runtime event submission for those lines
- **中文** 当 CLI host tests 运行包含 `/palette` 与 `/keymap` 的 scripted chat input 时，测试必须断言本地输出 records，且这些行不提交 model/runtime event。

#### Scenario: Chat palette action failures are tested / Chat Palette Action 失败被测试
- **WHEN** CLI host tests run scripted chat input containing an unknown palette action target
- **THEN** tests assert typed diagnostics and no unstructured host exception
- **中文** 当 CLI host tests 运行包含未知 palette action target 的 scripted chat input 时，测试必须断言 typed diagnostics，且没有非结构化 host exception。

#### Scenario: Chat help includes palette controls / Chat Help 包含 Palette 控制被测试
- **WHEN** CLI host tests run `/help`
- **THEN** tests assert `/palette`, `/palette action`, and `/keymap` are listed
- **中文** 当 CLI host tests 运行 `/help` 时，测试必须断言列出了 `/palette`、`/palette action` 和 `/keymap`。

### Requirement: Chat Palette Navigation Regression Coverage / Chat Palette 导航回归覆盖

The regression suite SHALL cover stateful chat palette navigation, palette state summaries, reference-set updates, typed local failures, and no model/runtime submission for palette navigation commands.

Regression suite 必须覆盖有状态 chat palette navigation、palette state summaries、reference-set updates、类型化本地失败，以及 palette navigation commands 不提交 model/runtime。

#### Scenario: Navigation records are tested / 导航 Records 被测试
- **WHEN** CLI host tests run scripted chat input containing `/palette`, `/palette next`, and `/palette state`
- **THEN** tests assert structured local records with changed focus and no model/runtime event submission
- **中文** 当 CLI host tests 运行包含 `/palette`、`/palette next` 和 `/palette state` 的 scripted chat input 时，测试必须断言结构化本地 records、焦点变化以及没有 model/runtime event submission。

#### Scenario: Reference updates are tested / Reference Updates 被测试
- **WHEN** CLI host tests run scripted chat input containing `/palette refs add current`
- **THEN** tests assert the active reference count increases through typed local action resolution
- **中文** 当 CLI host tests 运行包含 `/palette refs add current` 的 scripted chat input 时，测试必须断言 active reference count 通过类型化本地 action resolution 增加。

#### Scenario: Invalid navigation stays local in tests / 无效导航在测试中保持本地
- **WHEN** CLI host tests run malformed palette navigation input
- **THEN** tests assert a typed local failure and no unstructured host exception
- **中文** 当 CLI host tests 运行格式错误的 palette navigation input 时，测试必须断言 typed local failure，且没有非结构化 host exception。

### Requirement: CLI Revert Preview Regression Coverage / CLI 回退预览回归覆盖

The regression suite SHALL cover scriptable and chat-local revert preview controls, typed empty failures, malformed target failures, and non-mutating behavior.

Regression suite 必须覆盖可脚本化与 chat-local revert preview controls、类型化 empty failures、malformed target failures 和 non-mutating behavior。

#### Scenario: Scriptable revert preview is tested / 可脚本化回退预览被测试
- **WHEN** CLI host tests run `deepseek revert preview --request <request-id> --output json`
- **THEN** tests assert structured dry-run output and typed empty diagnostics when no checkpoint matches
- **中文** 当 CLI host tests 运行 `deepseek revert preview --request <request-id> --output json` 时，测试必须断言结构化 dry-run output，以及没有 matching checkpoint 时的 typed empty diagnostics。

#### Scenario: Chat revert preview is tested / Chat 回退预览被测试
- **WHEN** CLI host tests run scripted chat input containing `/revert preview --turn <turn-id>`
- **THEN** tests assert local output records and no model/runtime event submission for that line
- **中文** 当 CLI host tests 运行包含 `/revert preview --turn <turn-id>` 的 scripted chat input 时，测试必须断言本地 output records，且该行不提交 model/runtime event。

#### Scenario: Revert preview does not mutate test state / 回退预览不修改测试状态
- **WHEN** tests run revert preview against an injected workspace state manager with eligible checkpoints
- **THEN** checkpoint statuses and file content remain unchanged after preview
- **中文** 当测试对注入了 eligible checkpoints 的 workspace state manager 运行 revert preview 时，preview 后 checkpoint statuses 与 file content 必须保持不变。

### Requirement: Chat History Current Revert Regression Coverage / Chat History Current Revert 回归覆盖

The regression suite SHALL cover local chat history listing, history selection, `/revert preview current`, empty-history failures, and no model/runtime submission for history controls.

Regression suite 必须覆盖本地 chat history listing、history selection、`/revert preview current`、empty-history failures，以及 history controls 不提交 model/runtime。

#### Scenario: History listing is tested / History Listing 被测试
- **WHEN** CLI host tests run scripted chat input with prompt turns followed by `/history`
- **THEN** tests assert local history records with turn ids, selected markers, and no raw ANSI controls in structured output
- **中文** 当 CLI host tests 运行包含 prompt turns 后接 `/history` 的 scripted chat input 时，测试必须断言本地 history records 包含 turn ids、selected markers，且 structured output 没有 raw ANSI controls。

#### Scenario: Revert current is tested / Revert Current 被测试
- **WHEN** CLI host tests run scripted chat input with `/revert preview current`
- **THEN** tests assert the preview target is the selected explicit turn/session target and no model request is submitted for the slash line
- **中文** 当 CLI host tests 运行包含 `/revert preview current` 的 scripted chat input 时，测试必须断言 preview target 是选中的显式 turn/session target，且 slash line 不提交 model request。

#### Scenario: Empty current failure is tested / Empty Current Failure 被测试
- **WHEN** CLI host tests run `/revert preview current` before any prompt turn
- **THEN** tests assert a typed local failure and no unstructured exception
- **中文** 当 CLI host tests 在任何 prompt turn 前运行 `/revert preview current` 时，测试必须断言 typed local failure，且没有非结构化 exception。

### Requirement: Revert Apply Regression Coverage / 回退执行回归覆盖

Regression tests SHALL cover scriptable and chat-local revert apply behavior with deterministic injected workspace checkpoints.

回归测试必须使用确定性注入的 workspace checkpoints 覆盖可脚本化与 chat-local revert apply 行为。

#### Scenario: Successful apply mutates through checkpoint / 成功执行通过 Checkpoint 修改

- **WHEN** a test injects an eligible checkpoint and runs `deepseek revert apply --request <request-id> --output json`
- **THEN** the assertion verifies the file content is restored, the checkpoint status is `restored`, and no raw rollback content appears in externally visible records
- **中文** 当测试注入 eligible checkpoint 并运行 `deepseek revert apply --request <request-id> --output json` 时，断言必须验证 file content 已恢复、checkpoint status 为 `restored`，且 externally visible records 不包含 raw rollback content。

#### Scenario: Stale apply is non-mutating / 过期执行不修改

- **WHEN** a test mutates the file after checkpoint creation and then runs revert apply
- **THEN** the assertion verifies stale diagnostics are emitted, file content remains unchanged, and the checkpoint remains eligible
- **中文** 当测试在 checkpoint 创建后再次修改文件并运行 revert apply 时，断言必须验证输出 stale diagnostics、file content 保持不变，且 checkpoint 仍为 eligible。

#### Scenario: Chat apply slash stays local / Chat 执行 Slash 保持本地

- **WHEN** a scripted chat input runs `/revert apply current`
- **THEN** the assertion verifies the slash command emits `chat.command.revert-apply`, does not emit a model request for that slash command, and preserves structured JSONL output without ANSI escape sequences
- **中文** 当 scripted chat input 运行 `/revert apply current` 时，断言必须验证 slash command 输出 `chat.command.revert-apply`，不会为该 slash command 发出 model request，并保持 structured JSONL output 不含 ANSI escape sequences。

### Requirement: Revert Review Confirm Regression Coverage / 回退审阅确认回归覆盖

Regression tests SHALL cover chat-local revert review and confirm controls with deterministic workspace checkpoints and structured output assertions.

回归测试必须使用确定性 workspace checkpoints 和结构化输出断言覆盖 chat-local revert review 与 confirm controls。

#### Scenario: Review and confirm success is tested / 审阅并确认成功被测试

- **WHEN** CLI host tests run a scripted chat input with a mutating turn followed by `/revert review current` and `/revert confirm current`
- **THEN** tests assert the review record is dry-run, the confirmation applies through checkpoint restore safety checks, the file is restored, and the slash commands do not submit model requests
- **中文** 当 CLI host tests 运行包含 mutating turn 后接 `/revert review current` 与 `/revert confirm current` 的 scripted chat input 时，测试必须断言 review record 是 dry-run、confirmation 通过 checkpoint restore safety checks 执行、file 被恢复，且这些 slash commands 不提交 model request。

#### Scenario: Confirm without review is tested / 未审阅确认被测试

- **WHEN** CLI host tests run `/revert confirm current` before any pending review exists
- **THEN** tests assert a typed local failure and no unstructured host exception
- **中文** 当 CLI host tests 在没有 pending review 时运行 `/revert confirm current`，测试必须断言 typed local failure，且没有非结构化 host exception。

#### Scenario: Stale confirm is tested / 过期确认被测试

- **WHEN** tests mutate a file after review and before confirm
- **THEN** tests assert confirm emits stale diagnostics and leaves the file and checkpoint unchanged
- **中文** 当测试在 review 后、confirm 前修改文件时，测试必须断言 confirm 输出 stale diagnostics，并保持 file 与 checkpoint 不变。

### Requirement: Palette Jump Navigation Regression Coverage / Palette 跳转导航回归覆盖

Regression tests SHALL cover typed palette jump back/forward action resolution and chat-local slash controls with deterministic state assertions.

回归测试必须用确定性 state assertions 覆盖 typed palette jump back/forward action resolution 与 chat-local slash controls。

#### Scenario: Contract jump traversal is tested / Contract 跳转遍历被测试

- **WHEN** contract tests resolve `back` and `forward` against a composition snapshot with jump history
- **THEN** tests assert cursor movement, active target updates, matching result-list focus updates, typed failure at bounds, and no owner execution
- **中文** 当 contract tests 基于带 jump history 的 composition snapshot 解析 `back` 与 `forward` 时，测试必须断言 cursor movement、active target updates、matching result-list focus updates、边界 typed failure 和不执行 owner。

#### Scenario: Chat jump controls are tested / Chat 跳转控制被测试

- **WHEN** CLI host tests run scripted chat input containing `/palette`, navigation commands, `/palette back`, `/palette forward`, and `/palette state`
- **THEN** tests assert structured local JSONL records, changed focus, expected jump cursor values, no ANSI controls, and no model/runtime submission for the slash lines
- **中文** 当 CLI host tests 运行包含 `/palette`、navigation commands、`/palette back`、`/palette forward` 与 `/palette state` 的 scripted chat input 时，测试必须断言结构化本地 JSONL records、focus 变化、预期 jump cursor values、无 ANSI controls，以及 slash lines 不提交 model/runtime。

#### Scenario: Empty chat jump is tested / 空 Chat 跳转被测试

- **WHEN** CLI host tests run `/palette back` before any jump history exists
- **THEN** tests assert a typed palette diagnostic and no unstructured host exception
- **中文** 当 CLI host tests 在没有 jump history 前运行 `/palette back` 时，测试必须断言 typed palette diagnostic，且没有非结构化 host exception。

### Requirement: Chat Reference Set Regression Coverage / Chat 引用集回归覆盖

Regression tests SHALL cover reference-set listing, focus switching, missing selector diagnostics, and local/no-model behavior for chat palette reference controls.

回归测试必须覆盖 chat palette reference controls 的 reference-set listing、focus switching、missing selector diagnostics 和 local/no-model behavior。

#### Scenario: Reference list is tested / 引用列表被测试

- **WHEN** CLI host tests run scripted chat input that adds a focused palette item to references and invokes `/palette refs list`
- **THEN** tests assert structured JSONL set and item records, active item metadata, redaction metadata, no ANSI controls, and no model/runtime submission for reference slash lines
- **中文** 当 CLI host tests 运行 scripted chat input，将当前 palette item 加入 references 后调用 `/palette refs list` 时，测试必须断言结构化 JSONL set 与 item records、active item metadata、redaction metadata、无 ANSI controls，以及 reference slash lines 不提交 model/runtime。

#### Scenario: Reference focus is tested / 引用聚焦被测试

- **WHEN** CLI host tests add multiple reference items and invoke `/palette refs focus <selector>`
- **THEN** tests assert active reference focus changes to the selected item while existing references remain present
- **中文** 当 CLI host tests 增加多个 reference items 并调用 `/palette refs focus <selector>` 时，测试必须断言 active reference focus 切换到选中 item，同时已有 references 仍存在。

#### Scenario: Missing reference focus is tested / 缺失引用聚焦被测试

- **WHEN** CLI host tests invoke `/palette refs focus missing-reference`
- **THEN** tests assert a typed diagnostic or local failure and no unstructured host exception
- **中文** 当 CLI host tests 调用 `/palette refs focus missing-reference` 时，测试必须断言 typed diagnostic 或 local failure，且没有非结构化 host exception。

#### Scenario: Contract focus action is tested / Contract 聚焦动作被测试

- **WHEN** contract tests resolve `focus-reference` against a composition snapshot with reference sets
- **THEN** tests assert active target updates, active item id updates, reference items are preserved, and missing targets return typed diagnostics
- **中文** 当 contract tests 基于带 reference sets 的 composition snapshot 解析 `focus-reference` 时，测试必须断言 active target updates、active item id updates、reference items 被保留，以及 missing targets 返回 typed diagnostics。

### Requirement: Chat Reference Context Regression Coverage / Chat 引用上下文回归覆盖

Regression tests SHALL cover active chat reference metadata propagation into agent loop requests and runtime/model metadata without raw content leakage.

回归测试必须覆盖 active chat reference metadata 向 agent loop requests 与 runtime/model metadata 的传播，并确保没有 raw content 泄漏。

#### Scenario: Reference context propagation is tested / 引用上下文传播被测试

- **WHEN** CLI host tests run scripted chat input that adds references and then submits a normal prompt
- **THEN** tests assert `agent.loop.started`, `turn.started`, and `model.requested` metadata include reference set/item ids, active item id, target ids, and counts
- **中文** 当 CLI host tests 运行 scripted chat input，先增加 references 再提交普通 prompt 时，测试必须断言 `agent.loop.started`、`turn.started` 与 `model.requested` metadata 包含 reference set/item ids、active item id、target ids 和 counts。

#### Scenario: Raw reference content is absent / 原始引用内容不存在

- **WHEN** reference context metadata is serialized in JSONL output
- **THEN** tests assert raw file contents, raw prompt duplication, credentials, and unredacted secret-like values are absent
- **中文** 当 reference context metadata 被序列化到 JSONL output 时，测试必须断言 raw file contents、raw prompt duplication、credentials 和未脱敏 secret-like values 不存在。

#### Scenario: Slash controls do not submit model requests / Slash 控制不提交模型请求

- **WHEN** tests run only `/palette refs ...` slash commands
- **THEN** tests assert no `model.requested` event is emitted until a subsequent non-slash prompt is submitted
- **中文** 当测试只运行 `/palette refs ...` slash commands 时，必须断言在后续非 slash prompt 提交前不会发出 `model.requested` event。

### Requirement: Chat Reference Projection Regression Coverage / Chat 引用投影回归覆盖

Regression tests SHALL cover governed projection of chat file references into model requests while preserving prompt boundaries and excluding unsafe references.

回归测试必须覆盖 chat file references 受治理地投影进 model requests，同时保持 prompt 边界并排除不安全 references。

#### Scenario: File reference content reaches model through projection / 文件引用内容通过投影到达模型

- **WHEN** a deterministic runtime test submits a prompt with an active file reference
- **THEN** tests assert projection events select the reference, the model request contains a runtime-owned context message, and the user prompt message remains unchanged
- **中文** 当 deterministic runtime test 提交带 active file reference 的 prompt 时，测试必须断言 projection events 选中该 reference、model request 包含 runtime-owned context message，且 user prompt message 保持不变。

#### Scenario: Slash add-file remains local / add-file Slash 保持本地

- **WHEN** CLI host tests run only `/palette refs add-file <path>` and `/palette refs list`
- **THEN** tests assert local structured records and no `model.requested` event is emitted
- **中文** 当 CLI host tests 只运行 `/palette refs add-file <path>` 与 `/palette refs list` 时，测试必须断言输出 local structured records，且不会发出 `model.requested` event。

#### Scenario: Unsafe referenced content is excluded / 不安全引用内容被排除

- **WHEN** a referenced file contains secret-like content
- **THEN** tests assert projection exclusion/redaction evidence is emitted and the raw secret-like content is absent from model requests and JSONL output
- **中文** 当被引用文件包含疑似 secret content 时，测试必须断言输出 projection exclusion/redaction evidence，且 raw secret-like content 不存在于 model requests 与 JSONL output。

### Requirement: Chat File Search Regression Coverage / Chat 文件搜索回归覆盖

Regression tests SHALL cover chat-local file search result lists, navigation, current-file reference creation, prompt-time projection, and no slash-command model submission.

回归测试必须覆盖 chat-local file search result lists、navigation、current-file reference creation、prompt-time projection，以及 slash-command 不提交 model。

#### Scenario: File search slash stays local in tests / 文件搜索 Slash 在测试中保持本地

- **WHEN** CLI host tests run scripted chat input containing `/palette files <pattern>` and navigation commands
- **THEN** tests assert local file-search and palette action records, changed result-list focus, no ANSI controls in structured output, and no `model.requested` event before a non-slash prompt
- **中文** 当 CLI host tests 运行包含 `/palette files <pattern>` 与 navigation commands 的 scripted chat input 时，测试必须断言本地 file-search 与 palette action records、result-list focus 变化、structured output 不含 ANSI controls，并且非 slash prompt 前没有 `model.requested` event。

#### Scenario: Current file result projects on prompt / 当前文件结果在 Prompt 投影

- **WHEN** CLI host tests focus a file result, run `/palette refs add current`, and then submit a normal prompt
- **THEN** tests assert the active reference item is `kind=file`, the model request contains runtime-owned projected file context, and the user prompt message remains unchanged
- **中文** 当 CLI host tests 聚焦 file result、运行 `/palette refs add current` 后提交普通 prompt 时，测试必须断言 active reference item 为 `kind=file`、model request 包含 runtime-owned projected file context，且 user prompt message 保持不变。

#### Scenario: File search content boundary is tested / 文件搜索内容边界被测试

- **WHEN** CLI host tests run only `/palette files <pattern>` and reference slash commands before a prompt
- **THEN** tests assert raw matched file content is absent from local JSONL records and no model request is emitted
- **中文** 当 CLI host tests 在 prompt 前只运行 `/palette files <pattern>` 与 reference slash commands 时，测试必须断言 local JSONL records 不包含 matched file raw content，且不发出 model request。

### Requirement: Chat Text Search Regression Coverage / Chat 文本搜索回归覆盖

Regression tests SHALL cover chat-local text search result lists, navigation, current-match reference creation, prompt-time projection, and no slash-command model submission.

回归测试必须覆盖 chat-local text search result lists、navigation、current-match reference creation、prompt-time projection，以及 slash-command 不提交 model。

#### Scenario: Text search slash stays local in tests / 文本搜索 Slash 在测试中保持本地

- **WHEN** CLI host tests run scripted chat input containing `/palette grep <text>` and navigation commands
- **THEN** tests assert local text-search and palette action records, changed result-list focus, no ANSI controls in structured output, and no `model.requested` event before a non-slash prompt
- **中文** 当 CLI host tests 运行包含 `/palette grep <text>` 与 navigation commands 的 scripted chat input 时，测试必须断言本地 text-search 与 palette action records、result-list focus 变化、structured output 不含 ANSI controls，并且非 slash prompt 前没有 `model.requested` event。

#### Scenario: Current text result projects through file reference / 当前文本结果通过文件引用投影

- **WHEN** CLI host tests focus a text search result, run `/palette refs add current`, and then submit a normal prompt
- **THEN** tests assert the active reference item is `kind=file` with line metadata, the model request contains runtime-owned projected file context, and the user prompt message remains unchanged
- **中文** 当 CLI host tests 聚焦 text search result、运行 `/palette refs add current` 后提交普通 prompt 时，测试必须断言 active reference item 为带 line metadata 的 `kind=file`、model request 包含 runtime-owned projected file context，且 user prompt message 保持不变。

#### Scenario: Text search full-content boundary is tested / 文本搜索完整内容边界被测试

- **WHEN** CLI host tests run only `/palette grep <text>` and reference slash commands before a prompt
- **THEN** tests assert non-matching raw file content is absent from local JSONL records and no model request is emitted
- **中文** 当 CLI host tests 在 prompt 前只运行 `/palette grep <text>` 与 reference slash commands 时，测试必须断言 local JSONL records 不包含 non-matching raw file content，且不发出 model request。

### Requirement: Chat Reference Mutation Regression Coverage / Chat 引用变更回归覆盖

Regression tests SHALL cover chat-local reference remove, clear, replace-current, missing-target failures, no slash-command model submission, and prompt-boundary preservation after mutations.

回归测试必须覆盖 chat-local reference remove、clear、replace-current、missing-target failures、slash-command 不提交模型，以及 mutations 后的 prompt-boundary preservation。

#### Scenario: Remove and clear are tested / 移除与清空被测试

- **WHEN** CLI host tests run scripted chat input that adds references, removes one, clears the set, and lists references
- **THEN** tests assert deterministic reference counts, active reference focus updates, typed local records, no ANSI controls in structured output, and no model request for the slash commands
- **中文** 当 CLI host tests 运行 scripted chat input，添加 references、移除一项、清空集合并列出 references 时，测试必须断言确定性的 reference counts、active reference focus updates、typed local records、structured output 不含 ANSI controls，以及 slash commands 不提交 model request。

#### Scenario: Replace current projection is tested / 替换当前项投影被测试

- **WHEN** CLI host tests add multiple file references, focus a result-list item, run `/palette refs replace current`, and submit a normal prompt
- **THEN** tests assert the prompt carries exactly one active file reference, the projected model context comes from the replacement item, and the user prompt text remains unchanged
- **中文** 当 CLI host tests 添加多个 file references、聚焦 result-list item、运行 `/palette refs replace current` 并提交普通 prompt 时，测试必须断言 prompt 只携带一个 active file reference，projected model context 来自 replacement item，且 user prompt text 保持不变。

#### Scenario: Missing mutation target is tested / 缺失变更目标被测试

- **WHEN** CLI host tests run reference remove or replace commands with missing targets
- **THEN** tests assert typed local failures, preserved reference state, and no unstructured host exception
- **中文** 当 CLI host tests 运行目标缺失的 reference remove 或 replace commands 时，测试必须断言 typed local failures、reference state 被保留，且没有非结构化 host exception。

### Requirement: Chat PageIndex Recall Regression Coverage / Chat PageIndex 回溯回归覆盖

Regression tests SHALL cover chat-local PageIndex recording, deterministic recall result lists, navigation, no slash-command model submission, and bounded output.

回归测试必须覆盖 chat-local PageIndex recording、deterministic recall result lists、navigation、slash-command 不提交 model，以及有界输出。

#### Scenario: PageIndex recall slash stays local in tests / PageIndex Recall Slash 在测试中保持本地

- **WHEN** CLI host tests run scripted chat input containing two normal prompts followed by `/palette recall <query>` and navigation commands
- **THEN** tests assert only the normal prompts emit model requests, recall emits local structured records, recall result items use `turn` targets, focus changes through palette navigation, and structured output contains no ANSI controls
- **中文** 当 CLI host tests 运行包含两条普通 prompts、随后 `/palette recall <query>` 与 navigation commands 的 scripted chat input 时，测试必须断言只有普通 prompts 发出 model requests，recall 输出本地结构化 records，recall result items 使用 `turn` targets，focus 通过 palette navigation 改变，且 structured output 不包含 ANSI controls。

#### Scenario: Recall missing query is tested / 缺失 Recall Query 被测试

- **WHEN** CLI host tests run `/palette recall` without a query
- **THEN** tests assert a typed local failure and no unstructured host exception or model request
- **中文** 当 CLI host tests 运行没有 query 的 `/palette recall` 时，测试必须断言 typed local failure，且没有非结构化 host exception 或 model request。

#### Scenario: Recall preview boundary is tested / Recall Preview 边界被测试

- **WHEN** a prompt or assistant response contains text longer than the PageIndex preview limit
- **THEN** tests assert recall records contain bounded previews and do not serialize the full raw turn content
- **中文** 当 prompt 或 assistant response 包含超过 PageIndex preview limit 的文本时，测试必须断言 recall records 包含有界 previews，且不会序列化完整 raw turn content。

### Requirement: PageIndex Recall Reference Projection Regression Coverage / PageIndex 回溯引用投影回归覆盖

Regression tests SHALL cover PageIndex recall references becoming projected summary context without prompt mutation or full transcript access.

回归测试必须覆盖 PageIndex recall references 被投影为 summary context，且不修改 prompt、不访问完整 transcript。

#### Scenario: CLI recall reference projection is tested / CLI Recall 引用投影被测试

- **WHEN** CLI host tests run prompts, recall a prior turn, add the focused recall result as a reference, and submit another prompt
- **THEN** tests assert the reference item is `kind=turn`, the model request includes a runtime-owned projected PageIndex summary, the user prompt remains unchanged, recall slash commands do not submit model requests, and raw over-limit history text is absent from recall projection records
- **中文** 当 CLI host tests 运行 prompts、recall 先前 turn、将 focused recall result 加为 reference 并提交另一条 prompt 时，测试必须断言 reference item 是 `kind=turn`、model request 包含 runtime-owned projected PageIndex summary、user prompt 保持不变、recall slash commands 不提交 model requests，且超出限制的 history raw text 不出现在 recall projection records 中。

#### Scenario: Runtime turn-reference projection is tested / Runtime Turn 引用投影被测试

- **WHEN** runtime tests submit an `AgentLoopReferenceContext` containing a PageIndex-shaped turn reference
- **THEN** tests assert context projection selects a `summary` host node, unresolved reference count is zero, the system context message contains bounded PageIndex previews, and the user message remains unchanged
- **中文** 当 runtime tests 提交包含 PageIndex 形态 turn reference 的 `AgentLoopReferenceContext` 时，测试必须断言 context projection 选择 `summary` host node、unresolved reference count 为零、system context message 包含有界 PageIndex previews，且 user message 保持不变。

### Requirement: Chat PageIndex Snapshot Resume Regression Coverage / Chat PageIndex 快照恢复回归覆盖

Regression tests SHALL cover persisted PageIndex snapshot creation, explicit chat resume hydration, local recall after resume, explicit resume failure, and bounded snapshot serialization.

回归测试必须覆盖 PageIndex snapshot 创建、显式 chat resume hydrate、resume 后本地 recall、显式 resume failure，以及有界 snapshot serialization。

#### Scenario: Snapshot persistence is tested / 快照持久化被测试

- **WHEN** CLI host tests run a chat prompt with deterministic session dependencies
- **THEN** tests assert the session store receives a `chat.pageindex.snapshot` payload with bounded pages and no raw over-limit suffix
- **中文** 当 CLI host tests 使用确定性 session dependencies 运行 chat prompt 时，测试必须断言 session store 收到 `chat.pageindex.snapshot` payload，包含有界 pages 且不包含超限原文后缀。

#### Scenario: Resume recall is tested / 恢复回溯被测试

- **WHEN** CLI host tests start a second scripted chat with `--session <session-id>` against the same deterministic store and run `/palette recall <query>`
- **THEN** tests assert recall returns prior PageIndex `turn` targets, no model request is emitted for the resumed slash-only session, and structured output contains no ANSI controls
- **中文** 当 CLI host tests 使用同一个 deterministic store 以 `--session <session-id>` 启动第二个 scripted chat 并运行 `/palette recall <query>` 时，测试必须断言 recall 返回历史 PageIndex `turn` targets、该恢复后的 slash-only session 不发出 model request，并且 structured output 不包含 ANSI controls。

#### Scenario: Missing resume is tested / 缺失恢复被测试

- **WHEN** CLI host tests run `deepseek chat --session <missing-session-id>`
- **THEN** tests assert a typed local resume failure and no model request
- **中文** 当 CLI host tests 运行 `deepseek chat --session <missing-session-id>` 时，测试必须断言 typed local resume failure 且无 model request。

### Requirement: Chat PageIndex Recall Scope Regression Coverage / Chat PageIndex 回溯 Scope 回归覆盖

Regression tests SHALL cover default session recall, explicit session recall, executable workspace recall, locally deferred global scope, invalid scope failures, and no slash-command model submission.

回归测试必须覆盖默认 session recall、显式 session recall、可执行 workspace recall、本地延后的 global scope、invalid scope failures，以及 slash-command 不提交 model。

#### Scenario: Explicit session scope is tested / 显式 Session Scope 被测试

- **WHEN** CLI host tests run prompts followed by `/palette recall --scope session <query>`
- **THEN** tests assert the recall summary, result-list metadata, target metadata, and item metadata all carry `scope=session`
- **中文** 当 CLI host tests 运行 prompts 后执行 `/palette recall --scope session <query>` 时，测试必须断言 recall summary、result-list metadata、target metadata 与 item metadata 都携带 `scope=session`。

#### Scenario: Workspace scope is tested / Workspace Scope 被测试

- **WHEN** CLI host tests run `/palette recall --scope workspace <query>`
- **THEN** tests assert workspace recall result items carry `scope=workspace`, no session fallback result items are returned, and no model request is emitted for the slash command
- **中文** 当 CLI host tests 运行 `/palette recall --scope workspace <query>` 时，测试必须断言 workspace recall result items 携带 `scope=workspace`、没有 session fallback result items，且该 slash command 不发出 model request。

#### Scenario: Global scope is deferred in tests / Global Scope 延后被测试

- **WHEN** CLI host tests run `/palette recall --scope global <query>`
- **THEN** tests assert a typed deferred local record, no workspace result items, and no model request
- **中文** 当 CLI host tests 运行 `/palette recall --scope global <query>` 时，测试必须断言 typed deferred local record、没有 workspace result items，且没有 model request。

#### Scenario: Invalid scope is tested / 无效 Scope 被测试

- **WHEN** CLI host tests run `/palette recall --scope <invalid> <query>` or omit the scope value
- **THEN** tests assert a typed local failure and no unstructured host exception or model request
- **中文** 当 CLI host tests 运行 `/palette recall --scope <invalid> <query>` 或省略 scope value 时，测试必须断言 typed local failure，且没有非结构化 host exception 或 model request。

### Requirement: Chat Workspace PageIndex Regression Coverage / Chat Workspace PageIndex 回归覆盖

Regression tests SHALL cover workspace PageIndex persistence, cross-session workspace recall, storage failure behavior, bounded serialization, and continued global-scope deferral.

回归测试必须覆盖 workspace PageIndex persistence、跨 session workspace recall、storage failure behavior、有界 serialization，以及 global-scope 继续 deferred。

#### Scenario: Workspace recall across sessions is tested / 跨 Session Workspace Recall 被测试

- **WHEN** CLI host tests run one chat session that records a PageIndex page and a later chat session in the same workspace runs `/palette recall --scope workspace <query>`
- **THEN** tests assert workspace recall returns `turn` result items with `scope=workspace`, no model request is emitted for the slash-only session, and structured output contains no ANSI controls
- **中文** 当 CLI host tests 先运行一个记录 PageIndex page 的 chat session，再在同一 workspace 的后续 chat session 运行 `/palette recall --scope workspace <query>` 时，测试必须断言 workspace recall 返回带 `scope=workspace` 的 `turn` result items、slash-only session 不发出 model request，并且 structured output 不包含 ANSI controls。

#### Scenario: Workspace persistence boundary is tested / Workspace 持久化边界被测试

- **WHEN** CLI host tests record prompt or assistant text longer than the PageIndex preview limit
- **THEN** tests assert the persisted workspace PageIndex payload and recall records do not contain the raw over-limit suffix
- **中文** 当 CLI host tests 记录超过 PageIndex preview limit 的 prompt 或 assistant text 时，测试必须断言持久化 workspace PageIndex payload 与 recall records 不包含超限原文后缀。

#### Scenario: Workspace storage failure is tested / Workspace Storage Failure 被测试

- **WHEN** CLI host tests use a platform whose workspace metadata path or atomic write fails and then request workspace recall
- **THEN** tests assert a typed local failure or deferred diagnostic, no session fallback result items, and no model request
- **中文** 当 CLI host tests 使用 workspace metadata path 或 atomic write 失败的平台并请求 workspace recall 时，测试必须断言 typed local failure 或 deferred diagnostic、没有 session fallback result items，且没有 model request。

#### Scenario: Global scope remains deferred in tests / Global Scope 继续 Deferred 被测试

- **WHEN** CLI host tests run `/palette recall --scope global <query>`
- **THEN** tests assert the existing typed deferred behavior remains and no workspace result items are returned
- **中文** 当 CLI host tests 运行 `/palette recall --scope global <query>` 时，测试必须断言现有 typed deferred 行为保持不变，且不返回 workspace result items。

### Requirement: Context Memory Compact Main Path Regression / 上下文记忆压缩主路径回归

The regression suite SHALL cover memory projection, compact boundary replay, tool-result evidence redaction, and code-intelligence references/definitions fallback for CLI-first runtime turns.

Regression suite 必须覆盖 CLI-first runtime turns 的 memory projection、compact boundary replay、tool-result evidence redaction 与 code-intelligence references/definitions fallback。

#### Scenario: Memory and compact evidence replay / 记忆与压缩证据 replay

- **WHEN** a deterministic runtime turn includes memory candidates and compact pressure
- **THEN** regression tests assert ordered memory projection evidence, compact boundary fingerprints, redaction metadata, and stable replay records
- **中文** 当 deterministic runtime turn 包含 memory candidates 与 compact pressure 时，regression tests 必须断言有序 memory projection evidence、compact boundary fingerprints、redaction metadata 与 stable replay records。

#### Scenario: Tool and code evidence remain redacted / 工具与代码证据保持脱敏

- **WHEN** a deterministic runtime turn records tool-result evidence and code-intelligence references/definitions
- **THEN** tests assert bounded summaries, no raw secret-like stdout/stderr, structured fallback diagnostics, and deterministic fingerprints
- **中文** 当 deterministic runtime turn 记录 tool-result evidence 与 code-intelligence references/definitions 时，tests 必须断言 bounded summaries、无 raw secret-like stdout/stderr、structured fallback diagnostics 与 deterministic fingerprints。

### Requirement: MCP Plugin Auth Boundary Regression / MCP 插件认证边界回归

The regression suite SHALL cover scoped credential grants, MCP/plugin authorization denial, permission/auth diffs, CLI structured output, redaction, and replay fingerprints for R3 extension auth boundaries.

Regression suite 必须覆盖 R3 extension auth boundaries 的 scoped credential grants、MCP/plugin authorization denial、permission/auth diffs、CLI structured output、redaction 与 replay fingerprints。

#### Scenario: Scope denial is tested / 作用域拒绝被测试

- **WHEN** deterministic MCP or plugin fixtures request credentials outside declared scope
- **THEN** tests assert typed denial, no raw credential resolver call, redacted evidence, pit fixture ids, and stable replay fingerprints
- **中文** 当 deterministic MCP 或 plugin fixtures 请求超出 declared scope 的 credentials 时，测试必须断言 typed denial、不调用 raw credential resolver、redacted evidence、pit fixture ids 与 stable replay fingerprints。

#### Scenario: CLI auth evidence parity is tested / CLI 认证证据一致性被测试

- **WHEN** CLI extension/auth commands render plugin or MCP auth readiness, missing grant, or denial records
- **THEN** text and JSONL outputs are derived from the same structured evidence and contain no raw secret values
- **中文** 当 CLI extension/auth commands 渲染 plugin 或 MCP auth readiness、missing grant 或 denial records 时，text 与 JSONL outputs 必须来自同一 structured evidence，且不包含 raw secret values。

### Requirement: Plugin Auth Diff Regression / 插件认证 Diff 回归

Regression tests SHALL cover plugin updates that add or remove credential requirements in addition to permission changes.

Regression tests 必须覆盖 plugin updates 增加或移除 credential requirements 以及 permission changes 的情况。

#### Scenario: Auth requirement expansion is explicit / 认证需求扩张显式化

- **WHEN** a plugin update adds a credential requirement compared with a lockfile baseline
- **THEN** tests assert lifecycle evidence reports the exact auth requirement diff, permission diff remains exact, and audit metadata cites the relevant pit fixtures
- **中文** 当 plugin update 相比 lockfile baseline 增加 credential requirement 时，测试必须断言 lifecycle evidence 报告精确 auth requirement diff、permission diff 保持精确，并且 audit metadata 引用相关 pit fixtures。

### Requirement: Evidence-First Regression Coverage / 证据优先回归覆盖

The regression suite SHALL cover evidence-first behavior for repository facts, product pages, command recommendations, code explanations, reports, and generated artifacts.

regression suite 必须覆盖 repository facts、product pages、command recommendations、code explanations、reports 与 generated artifacts 的 evidence-first behavior。

#### Scenario: Fact-sensitive task requires evidence events / 事实敏感任务要求证据事件
- **WHEN** a deterministic runtime test submits a fact-sensitive project prompt
- **THEN** tests assert evidence classification, evidence plan, selected evidence summary, prompt boundary preservation, and claim grounding evidence before terminal output
- **中文** 当 deterministic runtime test 提交 fact-sensitive project prompt 时，测试必须断言 terminal output 之前存在 evidence classification、evidence plan、selected evidence summary、prompt boundary preservation 与 claim grounding evidence。

#### Scenario: Speculative task labels assumptions / 推测任务标注假设
- **WHEN** a deterministic runtime test submits an explicitly speculative or brainstorming prompt
- **THEN** tests assert mandatory evidence is skipped or reduced only with task classification evidence and assumption labeling
- **中文** 当 deterministic runtime test 提交明确 speculative 或 brainstorming prompt 时，测试必须断言只有带 task classification evidence 与 assumption labeling 时，mandatory evidence 才可跳过或降低。

### Requirement: Unsupported Claim Regression Fixtures / 未支持声明回归 Fixtures

The regression suite SHALL include fixtures that fail when generated project/product output contains unsupported commands, package names, feature claims, release states, or evaluation conclusions.

regression suite 必须包含当生成项目/产品输出含 unsupported commands、package names、feature claims、release states 或 evaluation conclusions 时会失败的 fixtures。

#### Scenario: Hallucinated CLI command is rejected / 幻觉 CLI 命令被拒绝
- **WHEN** a generated webpage or report claims `npx deepseek-cli init` without direct evidence
- **THEN** tests assert the checker or evaluation runner reports unsupported-command and does not mark the task solved
- **中文** 当生成网页或报告在没有直接证据时声明 `npx deepseek-cli init`，测试必须断言 checker 或 evaluation runner 报告 unsupported-command，且不将任务标为 solved。

#### Scenario: Evidence manifest is required for product webpage / 产品网页需要证据清单
- **WHEN** a generated product webpage passes structural HTML/CSS/JS checks but lacks an evidence manifest
- **THEN** tests assert the webpage checker fails with a missing-evidence-manifest diagnostic
- **中文** 当生成产品网页通过结构性 HTML/CSS/JS 检查但缺少 evidence manifest 时，测试必须断言 webpage checker 以 missing-evidence-manifest diagnostic 失败。

### Requirement: Evidence Schema Versioning / 证据 Schema 版本化

Evidence-first DTOs, events, manifests, and evaluation metrics SHALL be covered by schema versioning tests.

evidence-first DTOs、events、manifests 与 evaluation metrics 必须被 schema versioning tests 覆盖。

#### Scenario: Evidence artifacts declare schema versions / 证据产物声明 Schema 版本
- **WHEN** tests serialize evidence plans, evidence items, claim groundings, manifests, or unsupported-claim diagnostics
- **THEN** every artifact includes a supported schema version, compatibility metadata, stable ids, and redaction metadata
- **中文** 当测试序列化 evidence plans、evidence items、claim groundings、manifests 或 unsupported-claim diagnostics 时，每个 artifact 必须包含 supported schema version、compatibility metadata、stable ids 与 redaction metadata。

### Requirement: Self-Repair Regression Coverage / 自修复回归覆盖

The regression suite SHALL cover deterministic self-repair scenarios from failure classification through repair attempt, verification, and terminal decision.

regression suite 必须覆盖从 failure classification 到 repair attempt、verification 与 terminal decision 的确定性 self-repair scenarios。

#### Scenario: Tool failure repair replay is tested / 工具失败修复 Replay 被测试
- **WHEN** a deterministic runtime fixture triggers a repairable tool or artifact failure
- **THEN** regression tests assert classification, repair plan evidence, governed tool execution, verification result, terminal summary, and stable replay ordering
- **中文** 当 deterministic runtime fixture 触发可修复 tool 或 artifact failure 时，regression tests 必须断言 classification、repair plan evidence、受治理工具执行、verification result、terminal summary 与稳定 replay ordering。

#### Scenario: Non-repairable failure replay is tested / 不可修复失败 Replay 被测试
- **WHEN** a deterministic fixture triggers missing credentials, policy denial, approval-required, unsafe path, or external-service unavailable failure
- **THEN** regression tests assert the repair loop stops or escalates without workspace mutation and records a typed non-repairable reason
- **中文** 当 deterministic fixture 触发 missing credentials、policy denial、approval-required、unsafe path 或 external-service unavailable failure 时，regression tests 必须断言 repair loop 在不修改 workspace 的情况下停止或升级，并记录 typed non-repairable reason。

### Requirement: Self-Repair Evidence Contract Tests / 自修复证据契约测试

Contract tests SHALL validate self-repair DTOs, runtime events, observability records, evaluation metrics, redaction metadata, and schema versioning.

contract tests 必须验证 self-repair DTOs、runtime events、observability records、evaluation metrics、redaction metadata 与 schema versioning。

#### Scenario: Repair DTOs require schema and redaction / 修复 DTO 要求 Schema 与脱敏
- **WHEN** self-repair DTOs or events are serialized in tests
- **THEN** every public artifact includes schema version, stable ids, typed status, redaction metadata, compatibility metadata, and no raw secret fixture values
- **中文** 当 self-repair DTOs 或 events 在测试中序列化时，每个公共 artifact 必须包含 schema version、stable ids、typed status、redaction metadata、compatibility metadata，且不含 raw secret fixture values。

#### Scenario: Golden replay detects decision drift / Golden Replay 检测决策漂移
- **WHEN** self-repair golden traces are replayed
- **THEN** the harness detects drift in classification, repair policy decision, attempt ordering, verification ladder, stop reason, or redaction summary
- **中文** 当 self-repair golden traces 被 replay 时，harness 必须检测 classification、repair policy decision、attempt ordering、verification ladder、stop reason 或 redaction summary 的漂移。

### Requirement: Self-Repair Evaluation Fixtures / 自修复评估 Fixtures

The testing framework SHALL provide fixtures that intentionally fail first and require bounded correction before the task can be scored as solved.

testing framework 必须提供会先失败、并要求有界纠正后任务才能评分为 solved 的 fixtures。

#### Scenario: Failing webpage fixture requires repair / 失败网页 Fixture 要求修复
- **WHEN** the webpage-generation repair fixture is run
- **THEN** the initial artifact check fails deterministically and the task can only be scored solved after the generated webpage is repaired and the checker passes
- **中文** 当 webpage-generation repair fixture 运行时，初始 artifact check 必须确定性失败，且只有生成网页被修复并通过 checker 后，该任务才能评分为 solved。

#### Scenario: Failing code fixture requires targeted repair / 失败代码 Fixture 要求目标修复
- **WHEN** a code fixture intentionally triggers a typecheck, lint, import, or boundary failure
- **THEN** the task can only be scored solved after the targeted check passes and unrelated files remain outside the allowed changed-scope evidence
- **中文** 当 code fixture 有意触发 typecheck、lint、import 或 boundary failure 时，只有 targeted check 通过且无关文件保持在 allowed changed-scope evidence 外，该任务才能评分为 solved。

### Requirement: Mode Contract Tests / Mode 契约测试

Regression SHALL include contract tests for interaction mode, agent mode, transitions, work orders, worker results, and reasoning effort normalization.

Regression 必须包含 interaction mode、agent mode、transitions、work orders、worker results 与 reasoning effort normalization 的 contract tests。

#### Scenario: DTOs remain additive / DTO 保持可加性
- **WHEN** mode or orchestration DTOs are serialized and deserialized
- **THEN** unknown additive fields are preserved or ignored according to compatibility metadata without breaking older fixtures
- **中文** 当 mode 或 orchestration DTOs 被 serialized 与 deserialized 时，unknown additive fields 必须根据 compatibility metadata 被保留或忽略，且不得破坏旧 fixtures。

#### Scenario: DeepSeek effort mapping is tested / DeepSeek Effort 映射被测试
- **WHEN** a DeepSeek reasoning effort request is normalized
- **THEN** tests verify user-facing effort, provider-specific value, unsupported values, and diagnostics are recorded separately from loop budgets
- **中文** 当 DeepSeek reasoning effort request 被归一化时，tests 必须验证 user-facing effort、provider-specific value、unsupported values 与 diagnostics，并确认它们与 loop budgets 分开记录。

### Requirement: Golden Replay For Mode Decisions / Mode 决策 Golden Replay

Golden replay SHALL cover mode transitions, evidence loops, delegation, verification, worker continuation, worker stop, repair, and synthesis ordering.

Golden replay 必须覆盖 mode transitions、evidence loops、delegation、verification、worker continuation、worker stop、repair 与 synthesis ordering。

#### Scenario: Replay detects ordering drift / Replay 检测顺序漂移
- **WHEN** a mode-aware task golden trace is replayed
- **THEN** normalized event ordering shows classification before evidence, evidence before factual model dispatch, implementation before verification, and verification before final success
- **中文** 当 mode-aware task golden trace 被 replay 时，normalized event ordering 必须显示 classification 在 evidence 前、evidence 在 factual model dispatch 前、implementation 在 verification 前、verification 在 final success 前。

#### Scenario: Worker result is not user prompt / Worker 结果不是 User Prompt
- **WHEN** a worker completes in a golden trace
- **THEN** replay expects a typed worker-result event and fails if raw worker output is represented as unclassified user prompt text
- **中文** 当 worker 在 golden trace 中完成时，replay 必须期待 typed worker-result event；若 raw worker output 被表示为未分类 user prompt text，则失败。

### Requirement: Adversarial Mode Fixtures / 对抗性 Mode Fixtures

Regression SHALL include adversarial fixtures for mode mismatch, lazy delegation, over-delegation, missing verification, unsafe scratchpad, and unsupported reasoning effort.

Regression 必须包含 mode mismatch、lazy delegation、over-delegation、missing verification、unsafe scratchpad 与 unsupported reasoning effort 的对抗性 fixtures。

#### Scenario: Lazy delegation fixture fails / 惰性委派 Fixture 失败
- **WHEN** a worker work order lacks concrete context and only refers to prior findings or recent discussion
- **THEN** the fixture expects a typed rejection before worker launch
- **中文** 当 worker work order 缺少具体上下文，只引用 prior findings 或 recent discussion 时，fixture 必须期待 worker launch 前出现 typed rejection。

#### Scenario: Missing verification fixture is partial or failed / 缺失验证 Fixture 为部分或失败
- **WHEN** a non-trivial task completes without independent verification evidence
- **THEN** evaluation marks it partial or failed according to policy rather than full success
- **中文** 当非琐碎任务在没有 independent verification evidence 的情况下完成时，evaluation 必须按 policy 标记为 partial 或 failed，而不是 full success。

### Requirement: Cross-Platform Interaction Matrix / 跨平台交互矩阵

Regression SHALL test interaction mode behavior across representative terminal and host profiles.

Regression 必须跨代表性 terminal 与 host profiles 测试 interaction mode 行为。

#### Scenario: Degraded profiles preserve command semantics / 降级 Profile 保留命令语义
- **WHEN** tests run in CI, redirected JSONL, no-color, Windows PowerShell-like, macOS Terminal-like, and Linux Terminal-like profiles
- **THEN** local controls, result-list navigation, approvals, mode status, and runtime event rendering preserve semantics without ANSI leakage in structured modes
- **中文** 当 tests 在 CI、redirected JSONL、no-color、Windows PowerShell-like、macOS Terminal-like 与 Linux Terminal-like profiles 运行时，local controls、result-list navigation、approvals、mode status 与 runtime event rendering 必须保留语义，且 structured modes 不泄漏 ANSI。

### Requirement: Tool Family Catalog Regression / 工具家族目录回归
The regression suite SHALL include stable fixtures for the 16-domain/64-family catalog and fail when family ids, domains, risk classes, or rubric ids change without intentional fixture updates.

regression suite 必须包含 16-domain/64-family catalog 的稳定 fixtures；当 family ids、domains、risk classes 或 rubric ids 未经有意更新而变化时必须失败。

#### Scenario: Catalog snapshot detects removed family / Catalog Snapshot 检测被移除 Family
- **WHEN** a first-version family such as `patch.apply` is removed from the catalog
- **THEN** regression tests fail unless the change includes an explicit migration
- **中文** 当 `patch.apply` 等第一版 family 被移出 catalog 时，regression tests 必须失败，除非该变更包含显式 migration。

### Requirement: Family Projection Regression / Family 投影回归
Regression tests SHALL cover projection filtering by family, risk, agent scope, host requirements, connector trust, and provider support.

regression tests 必须覆盖按 family、risk、agent scope、host requirements、connector trust 与 provider support 的投影过滤。

#### Scenario: Denied domain excluded from projection / 被拒绝 Domain 从投影排除
- **WHEN** an agent scope denies the browser domain
- **THEN** projection fixtures show all `browser.*` families excluded from model-visible tools
- **中文** 当 agent scope 拒绝 browser domain 时，projection fixtures 必须显示所有 `browser.*` families 从 model-visible tools 中排除。

### Requirement: Pipeline Regression / 管线回归
Regression tests SHALL verify that runtime pipelines record sequence, parallel, artifact routing, stream bounds, policy decisions, and direct executor-call denial.

regression tests 必须验证 runtime pipelines 记录 sequence、parallel、artifact routing、stream bounds、policy decisions，并拒绝 direct executor-call。

#### Scenario: Executor-to-executor call is caught / Executor 互调被捕获
- **WHEN** a fixture attempts private executor-to-executor chaining
- **THEN** lint or runtime validation returns a stable failure
- **中文** 当 fixture 尝试 executor-to-executor 私下衔接时，lint 或 runtime validation 必须返回稳定失败。

### Requirement: Live Family Coverage Fixtures / Live Family Coverage Fixtures
Acceptance evidence SHALL include live or replayed fixtures that exercise representative tasks for implemented families and mark missing families as unassessed or absent with zero credit.

acceptance evidence 必须包含 live 或 replayed fixtures，覆盖已实现 families 的代表性任务，并将缺失 families 标记为 unassessed 或 absent 且零分。

#### Scenario: Missing design fixtures reduce score / 缺少 Design Fixtures 降低分数
- **WHEN** no live or replayed design family fixture exists
- **THEN** design family criteria do not pass and reduce objective score
- **中文** 当不存在 live 或 replayed design family fixture 时，design family criteria 不得通过，并必须降低 objective score。

### Requirement: Regression Covers All 64 Family Implementations / 回归覆盖全部 64 个 Family 实现
The regression suite SHALL include contract, projection, execution, safety, and score math tests for every first-version family.

regression suite 必须为每个第一版 family 包含 contract、projection、execution、safety 与 score math tests。

#### Scenario: Removing a family executor fails tests / 删除 Family Executor 导致测试失败
- **WHEN** an implemented family loses its executor or model-visible projection
- **THEN** regression tests fail and diagnostics report the family as incomplete
- **中文** 当某个已实现 family 丢失 executor 或 model-visible projection 时，regression tests 必须失败，diagnostics 必须报告该 family incomplete。

### Requirement: Acceptance Snapshots Record Family Evidence / Acceptance Snapshot 记录 Family 证据
Acceptance evidence SHALL include family parity snapshots, representative task fixtures, fake connector replay records, and optional live coverage records.

acceptance evidence 必须包含 family parity snapshots、representative task fixtures、fake connector replay records 与可选 live coverage records。

#### Scenario: Missing browser replay lowers score / 缺少 Browser Replay 降低分数
- **WHEN** browser family fake replay evidence is missing
- **THEN** browser implementation may exist but replay/task layers remain zero
- **中文** 当 browser family fake replay evidence 缺失时，browser implementation 可以存在，但 replay/task layers 必须保持零分。

### Requirement: Layered Delivery Regression Suite / 分层交付回归套件

The testing regression framework SHALL include deterministic and optional live-gated regression coverage for the layered delivery workflow.

testing regression framework 必须为 layered delivery workflow 提供 deterministic 与可选 live-gated regression 覆盖。

#### Scenario: Known benchmark gaps become product regressions / 已知评测缺口转为产品回归

- **WHEN** a live benchmark exposes a product gap such as pager hang, missing JSON schema validation, id/name semantic mismatch, absent memory gate, or adapter-only success
- **THEN** the gap is captured as a unit, contract, integration, golden, matrix, e2e, or live-gated regression at the owning layer
- **中文** 当 live benchmark 暴露 pager hang、missing JSON schema validation、id/name semantic mismatch、absent memory gate 或 adapter-only success 等产品缺口时，该缺口必须在负责层转化为 unit、contract、integration、golden、matrix、e2e 或 live-gated regression。

#### Scenario: Regression proves adapter slimness / 回归证明 Adapter 瘦身

- **WHEN** evaluation adapter tests run
- **THEN** they assert the adapter does not inject hidden task-specific solving rules and that product behavior is reproducible through CLI/runtime capabilities
- **中文** 当 evaluation adapter tests 运行时，必须断言 adapter 不注入隐藏任务专用解题规则，且产品行为可通过 CLI/runtime capabilities 复现。

### Requirement: Delivery Layer Evidence Is Replayable / 交付层证据可回放

Regression artifacts SHALL capture redacted, replayable evidence for each required delivery layer.

regression artifacts 必须为每个 required delivery layer 捕获脱敏、可回放证据。

#### Scenario: Golden trace includes layer outcomes / Golden Trace 包含层级结果

- **WHEN** a golden trace captures a structured or mutating agent task
- **THEN** it includes prompt assembly sections, tool envelopes, output contract verification, repair attempts, memory/context decisions, and terminal delivery layer summary
- **中文** 当 golden trace 捕获结构化或有副作用的 agent task 时，必须包含 prompt assembly sections、tool envelopes、output contract verification、repair attempts、memory/context decisions 与 terminal delivery layer summary。

### Requirement: First-Party Plugin Regression Coverage / 一方插件回归覆盖

The regression suite SHALL cover first-party plugin manifests, inert projection, permission evidence, command routing, TUI/palette integration, and release diagnostics.

regression suite 必须覆盖一方 plugin manifests、inert projection、permission evidence、command routing、TUI/palette integration 与 release diagnostics。

#### Scenario: Projection does not execute plugin owners / 投影不执行插件 Owner

- **WHEN** contract tests project first-party plugins into command composition, palette entries, TUI contributions, extension management, JSON, and JSONL outputs
- **THEN** tests assert deterministic records, provenance, permission metadata, diagnostics, and no command handler, process, git, npm, model, MCP, hook, or filesystem mutation execution
- **中文** 当 contract tests 将一方插件投影到 command composition、palette entries、TUI contributions、extension management、JSON 与 JSONL outputs 时，测试必须断言 records 确定、provenance 存在、permission metadata 存在、diagnostics 正确，且没有 command handler、process、git、npm、model、MCP、hook 或 filesystem mutation execution。

#### Scenario: Built-in manifest snapshots are stable / 内置 Manifest 快照稳定

- **WHEN** golden tests snapshot the first-party plugin pack
- **THEN** plugin ids, contribution ids, permissions, side effects, compatibility ranges, integrity values, and ordering remain deterministic across runs
- **中文** 当 golden tests 快照 first-party plugin pack 时，plugin ids、contribution ids、permissions、side effects、compatibility ranges、integrity values 与 ordering 必须在多次运行中保持确定。

### Requirement: Context Compaction Regression Coverage / 上下文压缩回归覆盖

The regression suite SHALL cover context compactor status, grep, describe, summarize, expand, budget, pin/reference, redaction, restart recovery, and summary reversibility.

regression suite 必须覆盖 context compactor status、grep、describe、summarize、expand、budget、pin/reference、redaction、restart recovery 与 summary reversibility。

#### Scenario: Summary expands to originals / Summary 展开为原文

- **WHEN** tests create lossless nodes, summarize them through the context compactor, and expand the summary
- **THEN** assertions confirm the expanded result includes the covered original redacted nodes and that raw nodes remain present in durable storage
- **中文** 当测试创建 lossless nodes、通过 context compactor 总结这些节点并 expand summary 时，断言必须确认 expanded result 包含被覆盖的原始脱敏 nodes，且 raw nodes 仍存在于 durable storage。

#### Scenario: Secret-like content stays redacted / 类 Secret 内容保持脱敏

- **WHEN** tests record context containing token, API key, password, or secret-like text and run grep, describe, summarize, expand, budget, and pin workflows
- **THEN** every text, JSON, JSONL, golden, and matrix output contains redaction markers instead of the raw secret-like values
- **中文** 当测试记录包含 token、API key、password 或 secret-like text 的 context，并运行 grep、describe、summarize、expand、budget 与 pin workflows 时，所有 text、JSON、JSONL、golden 与 matrix output 都必须包含 redaction markers，而不是 raw secret-like values。

### Requirement: Developer Workflow Plugin Coverage / 开发工作流插件覆盖

The regression suite SHALL cover the first-party developer check, repository navigation, and git review plugins with deterministic fakes and non-destructive behavior.

regression suite 必须用 deterministic fakes 与非破坏性行为覆盖 first-party developer check、repository navigation 与 git review plugins。

#### Scenario: Dev checks reject arbitrary shell / Dev Checks 拒绝任意 Shell

- **WHEN** tests invoke dev-check commands with unsupported arguments or free-form shell fragments
- **THEN** the command system returns typed diagnostics and no process execution is attempted
- **中文** 当测试使用 unsupported arguments 或 free-form shell fragments 调用 dev-check commands 时，command system 必须返回 typed diagnostics，且不得尝试 process execution。

#### Scenario: Git review is non-destructive / Git Review 非破坏性

- **WHEN** tests invoke git review projections
- **THEN** the plugin only reads deterministic git status/diff fixtures or governed read-only host outputs and never performs commit, checkout, reset, clean, merge, rebase, push, or branch deletion operations
- **中文** 当测试调用 git review projections 时，插件只能读取 deterministic git status/diff fixtures 或受治理 read-only host outputs，绝不执行 commit、checkout、reset、clean、merge、rebase、push 或 branch deletion operations。

### Requirement: Complete Plugin Platform Regression Matrix / 完整插件平台回归矩阵

The regression suite SHALL cover plugin lifecycle, API levels, contribution catalog, hooks, permissions, credentials, dependency resolution, conflicts, compatibility, rollback, health, host projection, and runtime governance.

Regression suite 必须覆盖 plugin lifecycle、API levels、contribution catalog、hooks、permissions、credentials、dependency resolution、conflicts、compatibility、rollback、health、host projection 与 runtime governance。

#### Scenario: Lifecycle matrix covers every state / 生命周期矩阵覆盖所有状态
- **WHEN** plugin lifecycle tests run
- **THEN** they cover discovered, validated, resolved, installed, enabled, activated, degraded, disabled, uninstalled, quarantined, update-staged, updated, rollback-ready, rolled-back, and health-checked states with deterministic replay fingerprints
- **中文** 当 plugin lifecycle tests 运行时，必须覆盖 discovered、validated、resolved、installed、enabled、activated、degraded、disabled、uninstalled、quarantined、update-staged、updated、rollback-ready、rolled-back 与 health-checked 状态，并带确定性 replay fingerprints。

#### Scenario: Catalog matrix covers contribution kinds / 目录矩阵覆盖贡献类型
- **WHEN** plugin catalog tests run
- **THEN** they cover command, action, target resolver, result-list provider, keymap, palette entry, render hint, hook, skill, tool, MCP connector, agent, context provider, memory/cache provider, workflow template, model profile, config fragment, diagnostics provider, and resource bundle descriptors
- **中文** 当 plugin catalog tests 运行时，必须覆盖 command、action、target resolver、result-list provider、keymap、palette entry、render hint、hook、skill、tool、MCP connector、agent、context provider、memory/cache provider、workflow template、model profile、config fragment、diagnostics provider 与 resource bundle descriptors。

#### Scenario: Governance matrix blocks private execution / 治理矩阵阻止私有执行
- **WHEN** malformed or malicious plugin fixtures attempt private callbacks, host layout mutation, runtime kernel access, raw credential access, direct filesystem/process/network imports, or undeclared owner routes
- **THEN** tests assert deterministic validation or activation denial before projection or execution
- **中文** 当 malformed 或 malicious plugin fixtures 尝试 private callbacks、host layout mutation、runtime kernel access、raw credential access、direct filesystem/process/network imports 或 undeclared owner routes 时，测试必须断言在 projection 或 execution 前发生确定性 validation 或 activation denial。

### Requirement: Plugin Host Projection Regression / 插件 Host 投影回归

Plugin projection tests SHALL cover CLI text, TUI inspector, JSON, JSONL, diagnostics, and future host descriptors without executing plugin handlers.

Plugin projection tests 必须覆盖 CLI text、TUI inspector、JSON、JSONL、diagnostics 与未来 host descriptors，且不得执行 plugin handlers。

#### Scenario: Projection remains inert / 投影保持惰性
- **WHEN** projection tests request all plugin states and contribution kinds
- **THEN** counters prove no command handler, hook handler, tool handler, MCP call, model call, filesystem mutation, process execution, or host callback ran
- **中文** 当 projection tests 请求所有 plugin states 与 contribution kinds 时，计数器必须证明没有 command handler、hook handler、tool handler、MCP call、model call、filesystem mutation、process execution 或 host callback 被运行。

#### Scenario: Inspector shows complete contract / 检查器展示完整契约
- **WHEN** plugin inspector tests render plugin details
- **THEN** they assert lifecycle state, API levels, source, trust, version, integrity, permissions, credentials, dependencies, conflicts, health, audit links, contribution list, and owner execution routes
- **中文** 当 plugin inspector tests 渲染 plugin details 时，必须断言 lifecycle state、API levels、source、trust、version、integrity、permissions、credentials、dependencies、conflicts、health、audit links、contribution list 与 owner execution routes。

### Requirement: Package Evidence Matrix / 包级证据矩阵

The regression suite SHALL produce or validate a package-level evidence matrix that separates lint, contract, integration, golden, matrix, e2e, live smoke, and acceptance evidence.

回归套件必须生成或校验包级证据矩阵，分别记录 lint、contract、integration、golden、matrix、e2e、live smoke 与 acceptance evidence。

#### Scenario: Evidence matrix distinguishes coverage types / 证据矩阵区分覆盖类型

- **WHEN** tests or acceptance tooling summarize package readiness
- **THEN** the matrix records which evidence types exist for each risk-bearing package and does not treat contract-only coverage as product readiness
- **中文** 当测试或验收工具汇总 package readiness 时，矩阵必须记录每个有风险 package 具备哪些证据类型，且不得把仅有 contract coverage 当作产品就绪。

#### Scenario: Sparse product coverage is visible / 稀疏产品覆盖可见

- **WHEN** e2e or live smoke coverage is sparse compared with package count or host surface claims
- **THEN** the evidence matrix reports a warning or release-blocking governance finding according to the configured launch gate
- **中文** 当 e2e 或 live smoke 覆盖相对 package 数量或 host surface 声明偏稀疏时，证据矩阵必须根据配置的 launch gate 报告 warning 或 release-blocking 治理发现。

### Requirement: Governance Fixture Coverage / 治理 Fixture 覆盖

Regression coverage SHALL include deterministic fixtures for ghost aliases, placeholder claims, deferred providers, rollout-gated modes, and host promotion gates.

回归覆盖必须包含关于幽灵 alias、占位声明、deferred providers、rollout-gated modes 与 host promotion gates 的确定性 fixtures。

#### Scenario: Ghost alias fixture fails lint / 幽灵 Alias Fixture 触发 Lint

- **WHEN** a fixture contains a `@deepseek/*` alias whose package target is missing and has no retired/merged governance record
- **THEN** the lint or regression test reports a stable governance diagnostic id
- **中文** 当 fixture 包含指向缺失 package 且没有 retired/merged 治理记录的 `@deepseek/*` alias 时，lint 或 regression test 必须报告稳定 governance diagnostic id。

#### Scenario: Placeholder claim fixture fails readiness / 占位声明 Fixture 触发 Readiness 失败

- **WHEN** a fixture claims remote, update, semantic indexing, or host promotion capability is product-ready while only placeholder or deferred evidence exists
- **THEN** readiness reports a release-blocking governance diagnostic
- **中文** 当 fixture 声称 remote、update、semantic indexing 或 host promotion 能力产品就绪，但只有 placeholder 或 deferred 证据时，readiness 必须报告 release-blocking governance diagnostic。

### Requirement: Governance Evidence Is Replay-Safe / 治理证据可 Replay

Governance findings SHALL be deterministic, redaction-aware, and suitable for golden replay and acceptance evidence.

治理发现必须确定性、具备 redaction，并适合 golden replay 与 acceptance evidence。

#### Scenario: Governance output is stable / 治理输出稳定

- **WHEN** the same repository state is evaluated twice
- **THEN** governance finding ids, maturity states, severities, and evidence references are stable except for explicitly allowed timestamps or environment metadata
- **中文** 当同一仓库状态被评估两次时，治理 finding id、成熟度状态、严重度和 evidence references 必须稳定，除非是显式允许的时间戳或环境元数据。

### Requirement: Kernel Governance Regression Fixtures / 内核治理回归 Fixtures

Regression coverage SHALL include deterministic fixtures for runtime kernel boundary violations, UAPI breaking changes, policy bypass attempts, unscoped agent writes, module private-object access, central-file growth, and context prefix instability.

回归覆盖必须包含 runtime kernel boundary violations、UAPI breaking changes、policy bypass attempts、unscoped agent writes、module private-object access、central-file growth 与 context prefix instability 的确定性 fixtures。

#### Scenario: Policy bypass fixture fails / Policy 绕过 Fixture 失败

- **WHEN** a fixture package attempts to execute file, shell, credential, plugin, MCP, or remote work without a policy decision record
- **THEN** regression tests produce a stable governance diagnostic and fail the readiness gate for the fixture
- **中文** 当 fixture package 尝试在没有 policy decision record 的情况下执行 file、shell、credential、plugin、MCP 或 remote work 时，回归测试必须产生稳定 governance diagnostic，并使该 fixture 的 readiness gate 失败。

#### Scenario: Unscoped agent fixture fails / 未限定 Scope 的 Agent Fixture 失败

- **WHEN** a fixture proposes write-capable worker execution without path, tool, budget, scratchpad, checkpoint, and lineage scopes
- **THEN** regression tests report missing agent namespace/quota evidence
- **中文** 当 fixture 在缺少 path、tool、budget、scratchpad、checkpoint 与 lineage scopes 时提议可写 worker execution，回归测试必须报告缺失 agent namespace/quota evidence。

### Requirement: Package-Level Evidence Matrix / 包级 Evidence Matrix

The regression system SHALL produce or validate a package-level evidence matrix for risk-bearing packages and host surfaces.

回归系统必须为有风险 packages 与 host surfaces 生成或校验包级 evidence matrix。

#### Scenario: Matrix distinguishes evidence types / 矩阵区分证据类型

- **WHEN** evidence is reported for a package or capability
- **THEN** the matrix distinguishes contract, integration, golden, matrix, e2e, live smoke, acceptance, and readiness evidence
- **中文** 当为 package 或 capability 报告 evidence 时，矩阵必须区分 contract、integration、golden、matrix、e2e、live smoke、acceptance 与 readiness evidence。

### Requirement: Risk-Based Evidence Thresholds / 基于风险的证据阈值

Evidence requirements SHALL vary by package risk tier, capability maturity, and host surface.

证据要求必须根据 package risk tier、capability maturity 与 host surface 变化。

#### Scenario: Contract-only evidence is not product readiness / Contract-only 不等于产品就绪

- **WHEN** a risk-bearing capability has only contract tests
- **THEN** the matrix marks product readiness as gated unless required integration, acceptance, e2e, live smoke, or readiness evidence is attached
- **中文** 当有风险能力只有 contract tests 时，矩阵必须将产品就绪标记为 gated，除非附加了必需的 integration、acceptance、e2e、live smoke 或 readiness evidence。

### Requirement: Stable Evidence Output / 稳定 Evidence 输出

Evidence matrix output SHALL be deterministic, redacted, and suitable for acceptance fixtures.

Evidence matrix 输出必须确定性、脱敏，并适合 acceptance fixtures。

#### Scenario: Matrix output is fixture-friendly / 矩阵输出适合 Fixture

- **WHEN** the matrix emits JSON or JSONL
- **THEN** records include stable ids, package, capability, evidence type, status, missing evidence, severity, and next action
- **中文** 当矩阵输出 JSON 或 JSONL 时，records 必须包含 stable ids、package、capability、evidence type、status、missing evidence、severity 与 next action。

### Requirement: Test-First Implementation Gate / 测试先行实现门禁

Non-documentation implementation work SHALL add or update focused behavior coverage before implementation code is changed.

非文档实现工作必须在修改实现代码前，先增加或更新聚焦的行为覆盖。

#### Scenario: Implementation starts with coverage / 实现从覆盖开始

- **WHEN** a change modifies implementation code under `src/**`
- **THEN** the change first adds or updates unit, contract, regression, golden, matrix, integration, or e2e coverage for the behavior
- **中文** 当变更修改 `src/**` 下的实现代码时，变更必须先增加或更新该行为的 unit、contract、regression、golden、matrix、integration 或 e2e 覆盖。

#### Scenario: Untestable implementation records exception / 无法先测的实现记录例外

- **WHEN** no practical test can be written before implementation
- **THEN** the OpenSpec task or design records the reason, risk, and substitute verification before implementation begins
- **中文** 当确实无法在实现前编写实用测试时，OpenSpec task 或 design 必须先记录原因、风险和替代验证方式，然后才能开始实现。

### Requirement: Prefix Stability Regression Coverage / 前缀稳定性回归覆盖

The regression suite SHALL cover deterministic prefix stability, cache opportunity preservation, cache opportunity loss, compaction, and replay for context pipeline manifests.

回归套件必须覆盖 context pipeline manifests 的确定性 prefix stability、cache opportunity preservation、cache opportunity loss、compaction 与 replay。

#### Scenario: Stable layers produce same prefix hash / 稳定层产生相同 Prefix Hash

- **WHEN** two deterministic turns differ only in current user input
- **THEN** regression tests assert that kernel and project prefix hashes remain unchanged and current-turn hashes differ
- **中文** 当两个确定性 turn 仅当前用户输入不同，回归测试必须断言 kernel 与 project prefix hashes 保持不变，current-turn hashes 发生变化。

#### Scenario: Project change invalidates project prefix / 项目变化使 Project Prefix 失效

- **WHEN** a project rule, package map, or project memory block changes
- **THEN** regression tests assert that project prefix hash changes while kernel prefix hash remains unchanged
- **中文** 当 project rule、package map 或 project memory block 变化时，回归测试必须断言 project prefix hash 变化，而 kernel prefix hash 保持不变。

### Requirement: Pipeline Backpressure Fixtures / 管道 Backpressure Fixtures

The regression suite SHALL include fixtures for bounded context streams and backpressure behavior.

回归套件必须包含有界 context streams 与 backpressure 行为的 fixtures。

#### Scenario: Oversized tool result is summarized / 超大工具结果被摘要

- **WHEN** a fixture tool result exceeds the stable session-layer threshold
- **THEN** tests assert that only bounded summary/reference blocks enter the session layer and raw content remains out of stable prefix evidence
- **中文** 当 fixture tool result 超过稳定 session-layer 阈值时，测试必须断言只有有界 summary/reference blocks 进入 session layer，raw content 不进入稳定 prefix evidence。

### Requirement: Provider Cache Metrics Fixtures / Provider 缓存指标 Fixtures

The regression suite SHALL cover provider cache metric normalization without requiring live provider access by default.

回归套件必须覆盖 provider cache metric normalization，默认不需要 live provider access。

#### Scenario: Mock provider returns cache usage / Mock Provider 返回缓存用量

- **WHEN** a deterministic provider fixture returns cache hit and miss token counts
- **THEN** tests assert that model-gateway records normalized cache usage and attaches it to the pipeline fingerprint
- **中文** 当确定性 provider fixture 返回 cache hit 与 miss token counts 时，测试必须断言 model-gateway 记录 normalized cache usage，并将其绑定到 pipeline fingerprint。

### Requirement: Test-First Lint Gate Regression / 测试先行 Lint 门禁回归

The regression suite SHALL include deterministic tests for the repository test-first lint gate and its allowed pass/fail cases.

回归套件必须包含仓库 test-first lint gate 及其允许通过/失败场景的确定性测试。

#### Scenario: Regression catches missing coverage / 回归捕获缺失覆盖

- **WHEN** a fixture repository changes a non-test implementation file under `src/**` without changing tests
- **THEN** the regression test asserts the test-first gate fails with a stable rule id or diagnostic marker
- **中文** 当 fixture repository 修改 `src/**` 下非测试实现文件但没有修改测试时，回归测试必须断言 test-first gate 以稳定 rule id 或 diagnostic marker 失败。

#### Scenario: Regression accepts changed tests / 回归接受测试变更

- **WHEN** a fixture repository changes implementation code and focused test files in the same change set
- **THEN** the regression test asserts the test-first gate passes
- **中文** 当 fixture repository 在同一变更集中修改实现代码与聚焦测试文件时，回归测试必须断言 test-first gate 通过。

#### Scenario: Regression accepts documented exception / 回归接受已记录例外

- **WHEN** a fixture repository changes implementation code without tests but has an active OpenSpec artifact containing `Test-first exception` and `Substitute verification`
- **THEN** the regression test asserts the test-first gate passes through the explicit exception path
- **中文** 当 fixture repository 修改实现代码但没有测试，同时 active OpenSpec artifact 包含 `Test-first exception` 与 `Substitute verification` 时，回归测试必须断言 test-first gate 通过明确例外路径。

### Requirement: OpenSpec Purpose Hygiene Regression / OpenSpec Purpose 卫生回归

The regression suite SHALL detect generated archive placeholder Purpose text in canonical OpenSpec specs.

回归套件必须检测 canonical OpenSpec specs 中的归档生成 Purpose 占位文本。

#### Scenario: Placeholder purpose fails contract test / 占位 Purpose 触发 Contract Test 失败

- **WHEN** a canonical spec under `openspec/specs/**/spec.md` contains `TBD - created by archiving change`
- **THEN** the contract test reports the spec path and fails
- **中文** 当 `openspec/specs/**/spec.md` 下的 canonical spec 包含 `TBD - created by archiving change` 时，contract test 必须报告 spec path 并失败。

#### Scenario: Bilingual purpose passes contract test / 双语 Purpose 通过 Contract Test

- **WHEN** every canonical spec Purpose has non-placeholder English and Chinese text
- **THEN** the contract test passes without requiring runtime or provider access
- **中文** 当每个 canonical spec Purpose 都具备非占位英文和中文文本时，contract test 必须在不需要 runtime 或 provider access 的情况下通过。

### Requirement: Offline Default Regression / Offline 默认回归

Default regression commands SHALL NOT require GLM network access, GLM credentials, provider availability, or account balance.

默认回归命令不得要求 GLM network access、GLM credentials、provider availability 或 account balance。

#### Scenario: Default tests remain offline / 默认测试保持 offline

- **WHEN** `npm test` runs
- **THEN** GLM live provider tests are skipped unless their dedicated live gate is set
- **中文** 当 `npm test` 运行时，GLM live provider tests 必须跳过，除非设置了它们的专用 live gate。

### Requirement: Adapter Refactor Regression / Adapter Refactor Regression

Provider adapter file reorganization SHALL be covered by deterministic regression tests that prove request construction, stream normalization, error redaction, and public exports remain stable.

provider adapter file reorganization 必须由 deterministic regression tests 覆盖，以证明 request construction、stream normalization、error redaction 与 public exports 保持稳定。

#### Scenario: Offline tests cover adapter moves / Offline tests 覆盖 adapter moves

- **WHEN** adapter implementation files move under vendor/protocol directories
- **THEN** focused model-gateway tests pass without live credentials or network access
- **中文** 当 adapter implementation files 移动到 vendor/protocol directories 下时，focused model-gateway tests 必须在不需要 live credentials 或 network access 的情况下通过。

#### Scenario: Live smoke gates remain opt-in / Live smoke gates 保持 opt-in

- **WHEN** default `npm test` runs after adapter reorganization
- **THEN** DeepSeek and GLM live smoke tests remain skipped unless their provider-specific live environment gates are explicitly set
- **中文** 当 adapter reorganization 后运行默认 `npm test` 时，DeepSeek 与 GLM live smoke tests 必须继续跳过，除非显式设置 provider-specific live environment gates。
