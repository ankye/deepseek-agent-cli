# local-readiness Specification

## Purpose
Define local readiness requirements for doctor, diagnostics, credentials, filesystem, platform, and CLI environment checks.

定义 local readiness 对 doctor、diagnostics、credentials、filesystem、platform 与 CLI environment checks 的要求。
## Requirements
### Requirement: R1 Local Readiness Commands / R1 本地可用性命令

The CLI SHALL provide `init`, `config`, `auth`, `doctor`, `privacy`, and `verify-install` commands as the R1 local readiness surface.

CLI 必须提供 `init`、`config`、`auth`、`doctor`、`privacy` 和 `verify-install` commands，作为 R1 local readiness surface。

#### Scenario: Readiness commands are discoverable / 可发现 readiness commands

- **WHEN** a user invokes CLI help or command discovery
- **THEN** the readiness commands are listed with stable names, structured command metadata, and host support metadata
- **中文** 当用户调用 CLI help 或 command discovery 时，readiness commands 必须以稳定名称、structured command metadata 和 host support metadata 展示。

#### Scenario: Readiness commands render structured output / readiness commands 渲染结构化输出

- **WHEN** a readiness command runs with text or JSON output
- **THEN** it returns command status, checks, warnings, redacted metadata, and suggested next actions without owning runtime execution state
- **中文** 当 readiness command 以 text 或 JSON 输出运行时，必须返回 command status、checks、warnings、redacted metadata 和 suggested next actions，且不拥有 runtime execution state。

### Requirement: Init And Config Readiness / Init 与 Config 可用性

The local readiness layer SHALL initialize project metadata and validate local configuration without overwriting user files unless explicitly requested.

local readiness layer 必须初始化 project metadata 并校验 local configuration，除非用户明确要求，否则不得覆盖用户文件。

#### Scenario: Init is idempotent / init 是幂等的

- **WHEN** `deepseek init` runs multiple times in the same workspace
- **THEN** it reports existing readiness state and does not rewrite user-owned files without an explicit force option
- **中文** 当 `deepseek init` 在同一 workspace 多次运行时，必须报告 existing readiness state，且没有显式 force option 时不得重写用户文件。

#### Scenario: Config validates known keys / config 校验已知键

- **WHEN** `deepseek config` validates local settings
- **THEN** it reports valid keys, unknown keys, invalid values, source location, and redacted sensitive values
- **中文** 当 `deepseek config` 校验 local settings 时，必须报告 valid keys、unknown keys、invalid values、source location 和 redacted sensitive values。

### Requirement: Auth And Privacy Readiness / Auth 与 Privacy 可用性

The local readiness layer SHALL verify selected provider credential presence and privacy settings without printing raw secrets or exporting telemetry by default. DeepSeek credential checks SHALL remain the default when no provider is selected; GLM Anthropic-compatible checks SHALL use GLM credential references when GLM is selected.

local readiness layer 必须验证 selected provider credential presence 与 privacy settings，且不得打印 raw secrets 或默认导出 telemetry。未选择 provider 时，DeepSeek credential checks 必须保持默认；选择 GLM 时，GLM Anthropic-compatible checks 必须使用 GLM credential references。

#### Scenario: Auth reports redacted credential reference / auth 报告脱敏凭证引用

- **WHEN** `deepseek auth` or `deepseek doctor` evaluates credentials for the selected model provider
- **THEN** it reports a scoped credential reference, provider id, source class, and redaction class without printing the raw value
- **中文** 当 `deepseek auth` 或 `deepseek doctor` 为 selected model provider 评估 credentials 时，必须报告 scoped credential reference、provider id、source class 与 redaction class，且不得打印 raw value。

#### Scenario: Privacy reports local policy / privacy 报告本地策略

- **WHEN** `deepseek privacy` runs
- **THEN** it reports local telemetry/export policy, diagnostic persistence policy, and opt-out state as structured metadata
- **中文** 当 `deepseek privacy` 运行时，必须以 structured metadata 报告 local telemetry/export policy、diagnostic persistence policy 和 opt-out state。

### Requirement: Doctor And Install Verification / Doctor 与安装验证

The local readiness layer SHALL provide deterministic diagnostics for platform, Node version, package metadata, workspace access, command availability, config validity, credential presence, and ignored local secret/reference paths.

local readiness layer 必须为 platform、Node version、package metadata、workspace access、command availability、config validity、credential presence 和 ignored local secret/reference paths 提供 deterministic diagnostics。

#### Scenario: Doctor emits checks / doctor 输出检查项

- **WHEN** `deepseek doctor` runs
- **THEN** it emits pass/warn/fail checks with stable ids, redacted metadata, and suggested next actions
- **中文** 当 `deepseek doctor` 运行时，必须输出带 stable ids、redacted metadata 和 suggested next actions 的 pass/warn/fail checks。

#### Scenario: Verify install checks package surface / verify install 检查包表面

- **WHEN** `deepseek verify-install` runs
- **THEN** it verifies CLI package metadata, executable availability, workspace package versions, and expected ignored local files without requiring network access
- **中文** 当 `deepseek verify-install` 运行时，必须验证 CLI package metadata、executable availability、workspace package versions 和 expected ignored local files，且不要求 network access。

### Requirement: Persistent Readiness State / 持久化可用性状态

The local readiness layer SHALL consume injected persistent config, workspace metadata, credential references, privacy settings, and platform diagnostics instead of relying on hardcoded readiness defaults.

local readiness layer 必须消费注入的 persistent config、workspace metadata、credential references、privacy settings 和 platform diagnostics，而不是依赖 hardcoded readiness defaults。

#### Scenario: Init creates metadata idempotently / init 幂等创建元数据

- **WHEN** `deepseek init` runs in a workspace without DeepSeek metadata
- **THEN** it creates the workspace metadata directory and initial non-secret config document through platform/config services and reports created paths as redacted metadata
- **中文** 当 `deepseek init` 在没有 DeepSeek metadata 的 workspace 中运行时，必须通过 platform/config services 创建 workspace metadata directory 和初始 non-secret config document，并以 redacted metadata 报告 created paths。

#### Scenario: Init preserves existing user state / init 保留已有用户状态

- **WHEN** `deepseek init` runs in an already initialized workspace without an explicit force input
- **THEN** it reports the existing metadata and does not overwrite config, credential references, session data, or user-authored files
- **中文** 当 `deepseek init` 在已初始化 workspace 中运行且没有显式 force input 时，必须报告 existing metadata，且不得覆盖 config、credential references、session data 或用户编写的文件。

### Requirement: Readiness Uses Resolved Config / 可用性使用解析后配置

Readiness commands SHALL report resolved config state with source metadata, schema diagnostics, profile metadata, and redacted values.

readiness commands 必须报告带 source metadata、schema diagnostics、profile metadata 和 redacted values 的 resolved config state。

#### Scenario: Config readiness shows precedence / config 可用性展示优先级

- **WHEN** `deepseek config` runs after user and workspace config values are persisted
- **THEN** it reports the effective resolved value, the winning source, shadowed lower-precedence sources, validation diagnostics, and suggested actions
- **中文** 当 `deepseek config` 在 user 和 workspace config values 已持久化后运行时，必须报告 effective resolved value、winning source、被更高优先级覆盖的 lower-precedence sources、validation diagnostics 和 suggested actions。

#### Scenario: Privacy readiness uses persisted policy / privacy 可用性使用持久化策略

- **WHEN** `deepseek privacy` runs
- **THEN** it reports persisted privacy and telemetry settings through structured metadata and does not export telemetry as part of the command
- **中文** 当 `deepseek privacy` 运行时，必须通过 structured metadata 报告 persisted privacy 和 telemetry settings，且 command 本身不得导出 telemetry。

### Requirement: Explicit Live Doctor / 显式 Live Doctor

The local readiness layer SHALL support explicit live connectivity verification for the selected model provider while keeping default `doctor` deterministic and offline.

local readiness layer 必须支持 selected model provider 的显式 live connectivity verification，同时保持默认 `doctor` deterministic 和 offline。

#### Scenario: Default doctor is offline / 默认 doctor 离线运行

- **WHEN** `deepseek doctor` runs without a live flag or live command input
- **THEN** it validates config, selected-provider credential presence, platform, install, privacy, and workspace metadata without calling a live model API
- **中文** 当 `deepseek doctor` 在没有 live flag 或 live command input 的情况下运行时，必须校验 config、selected-provider credential presence、platform、install、privacy 和 workspace metadata，且不得调用 live model API。

#### Scenario: Live doctor verifies provider through gateway / live doctor 通过 gateway 验证 provider

- **WHEN** `deepseek doctor --live` or `deepseek diagnostics doctor --live` runs with a selected provider and available credential reference
- **THEN** it calls model-gateway through injected credential resolution and returns provider id, protocol, model id, reachability, terminal status, latency metadata, and redacted diagnostics without exact model-text snapshots
- **中文** 当 `deepseek doctor --live` 或 `deepseek diagnostics doctor --live` 在 selected provider 与可用 credential reference 下运行时，必须通过 injected credential resolution 调用 model-gateway，并返回 provider id、protocol、model id、reachability、terminal status、latency metadata 与 redacted diagnostics，且不包含精确模型文本快照。

### Requirement: Release Readiness Checks / 发布就绪检查

Local readiness SHALL include release-readiness checks for CLI package metadata, package surface, expected verification commands, acceptance evidence pointers, and ignored forbidden paths.

local readiness 必须包含 CLI package metadata、package surface、expected verification commands、acceptance evidence pointers 和 ignored forbidden paths 的 release-readiness checks。

#### Scenario: Verify install includes release metadata / Verify Install 包含发布元数据

- **WHEN** `deepseek verify-install` runs
- **THEN** the result includes package name, version, executable name, bin target, publish access, expected package files, generated bundle status, and release verification commands as redacted metadata
- **中文** 当 `deepseek verify-install` 运行时，result 必须以脱敏 metadata 包含 package name、version、executable name、bin target、publish access、expected package files、generated bundle status 和 release verification commands。

#### Scenario: Doctor includes release readiness summary / Doctor 包含发布就绪摘要

- **WHEN** `deepseek doctor` runs offline
- **THEN** it includes deterministic release readiness checks without calling live provider, npm registry, plugin marketplace, or remote update services
- **中文** 当 `deepseek doctor` 离线运行时，它必须包含 deterministic release readiness checks，且不调用 live provider、npm registry、plugin marketplace 或 remote update services。

### Requirement: Support Bundle Awareness / 支持包感知

Local readiness SHALL surface whether local diagnostic bundles are available and whether external diagnostic export is denied by default.

local readiness 必须展示 local diagnostic bundles 是否可用，以及 external diagnostic export 是否默认拒绝。

#### Scenario: Privacy readiness mentions support bundle policy / Privacy Readiness 提及支持包策略

- **WHEN** `deepseek privacy` or diagnostics release readiness runs
- **THEN** metadata reports local diagnostic persistence, support bundle availability, external export denial reason, and redaction class
- **中文** 当 `deepseek privacy` 或 diagnostics release readiness 运行时，metadata 必须报告 local diagnostic persistence、support bundle availability、external export denial reason 和 redaction class。

### Requirement: Readiness Evidence Items Are Addressable / 可用性证据项可寻址

Readiness results SHALL expose stable check ids and evidence item ids suitable for quickfix-style diagnostics lists.

readiness results 必须暴露稳定 check ids 和 evidence item ids，适用于 quickfix-style diagnostics lists。

#### Scenario: Failed or warned checks can become targets / 失败或警告检查可成为 Target

- **WHEN** a readiness check returns warn or fail
- **THEN** its id, label, status, message, metadata, and suggested actions are stable enough for CLI diagnostics to reference without rerunning the check
- **中文** 当 readiness check 返回 warn 或 fail 时，它的 id、label、status、message、metadata 和 suggested actions 必须足够稳定，使 CLI diagnostics 可引用它而不重新运行检查。
