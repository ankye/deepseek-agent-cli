# credential-auth-management Specification

## Purpose
Define credential and authentication management requirements for provider credentials, redaction, storage references, and host-safe access.

定义 credential and authentication management 对 provider credentials、redaction、storage references 与 host-safe access 的要求。
## Requirements
### Requirement: Credential and Auth Boundary

The platform SHALL define credential and authentication management as a host-agnostic service for provider API keys, OAuth tokens, local credentials, enterprise credentials, and external connector credentials.

平台必须把 credential and authentication management 定义为 host-agnostic service，管理 provider API keys、OAuth tokens、local credentials、enterprise credentials 和 external connector credentials。

#### Scenario: Model gateway requests credential reference

- **WHEN** a model adapter needs credentials
- **THEN** it requests a scoped credential reference from the credential service instead of reading environment variables or files directly

#### Scenario: Host performs auth flow through adapter

- **WHEN** authentication requires browser, device-code, editor, or terminal interaction
- **THEN** the host adapter performs the UI flow and returns a structured credential result through shared contracts

### Requirement: Secret Storage and Redaction

The credential service SHALL support secure storage extension points, secret references, redaction rules, rotation metadata, expiration metadata, and audit records.

credential service 必须支持 secure storage extension points、secret references、redaction rules、rotation metadata、expiration metadata 和 audit records。

#### Scenario: Secret value does not enter session trace

- **WHEN** a credential is used by a model provider, MCP connector, plugin installer, or external resource
- **THEN** session, audit, protocol, and runtime bus traces record secret references and redacted summaries instead of raw secret values

### Requirement: Credential Scope and Policy

Credential access SHALL be scoped by provider, workspace, user, host, plugin, skill, connector, and capability permissions.

credential access 必须按 provider、workspace、user、host、plugin、skill、connector 和 capability permissions 进行 scope 管控。

#### Scenario: Plugin cannot read provider credential

- **WHEN** a plugin-contributed capability requests access to a model provider credential outside its declared permission scope
- **THEN** the credential service denies the request and records an audit event

### Requirement: Provider Credential Injection

Model provider adapters SHALL obtain provider credentials only through injected platform credential resolution and SHALL NOT read raw environment variables, local secret files, host keychains, or editor secrets directly.

model provider adapters 必须只通过注入的 platform credential resolution 获取 provider credentials，不得直接读取 raw environment variables、local secret files、host keychains 或 editor secrets。

#### Scenario: DeepSeek credential is missing

- **WHEN** a DeepSeek provider request requires authentication and the injected credential resolver cannot provide a credential
- **THEN** the provider emits a typed missing-credential error with secret-safe redaction metadata

#### Scenario: Raw credential access is rejected

- **WHEN** provider source code reads `process.env`, filesystem secrets, or host credential APIs directly for model credentials
- **THEN** architecture lint fails with a stable credential-boundary rule id

### Requirement: Credential Roadmap Staging / 凭证路线图分阶段

Credential and auth management SHALL stage personal provider credentials in R0/R1, MCP and plugin connector credentials in R3, remote/server credentials in R4, and enterprise-managed credentials in R7.

credential and auth management 必须将 personal provider credentials 放在 R0/R1，将 MCP 和 plugin connector credentials 放在 R3，将 remote/server credentials 放在 R4，将 enterprise-managed credentials 放在 R7。

#### Scenario: Personal credential is required before live provider launch / live provider 发布前需要个人凭证

- **WHEN** a roadmap node enables live provider execution
- **THEN** it declares scoped credential reference setup, redaction, rotation metadata, and no-raw-secret trace evidence
- **中文** 当路线图节点启用 live provider execution 时，必须声明 scoped credential reference setup、redaction、rotation metadata 和 no-raw-secret trace evidence。

#### Scenario: Connector credential waits for extension governance / connector 凭证等待扩展治理

- **WHEN** MCP, plugin, skill, or external connector auth is proposed
- **THEN** it declares R3 extension governance dependencies, permission scope, host-mediated auth flow, and audit evidence
- **中文** 当提出 MCP、plugin、skill 或 external connector auth 时，必须声明 R3 extension governance dependencies、permission scope、host-mediated auth flow 和 audit evidence。

### Requirement: Live Smoke Credential Loading / Live Smoke 凭证加载

Credential handling for live smoke SHALL load DeepSeek credentials from process environment or a local `.env` file as scoped secret references without adding `.env` contents to traces, test fixtures, or committed files.

live smoke 的 credential handling 必须从 process environment 或本地 `.env` 文件加载 DeepSeek credentials，并作为 scoped secret references 使用，不得把 `.env` 内容加入 traces、test fixtures 或 committed files。

#### Scenario: Environment credential is preferred / 优先使用环境凭证

- **WHEN** both process environment and `.env` contain a DeepSeek credential
- **THEN** the process environment value is used and represented as a secret credential reference
- **中文** 当 process environment 和 `.env` 都包含 DeepSeek credential 时，必须使用 process environment 值，并表示为 secret credential reference。

#### Scenario: Missing credential skips live smoke / 缺少凭证时跳过 live smoke

- **WHEN** live smoke is enabled but no DeepSeek credential is available
- **THEN** the smoke exits as skipped or unavailable without failing default deterministic tests
- **中文** 当 live smoke 已启用但没有 DeepSeek credential 时，smoke 必须以 skipped 或 unavailable 退出，且不影响默认 deterministic tests。

### Requirement: R1 Local Credential Reference / R1 本地凭证引用

Credential auth management SHALL support R1 local credential presence checks for `DEEPSEEK_API_KEY` and `DEEPSEEK_TOKEN` as secret references without raw value output.

credential auth management 必须支持 R1 local credential presence checks，将 `DEEPSEEK_API_KEY` 和 `DEEPSEEK_TOKEN` 作为 secret references 处理，且不输出 raw value。

#### Scenario: Credential presence is redacted / 凭证存在性被脱敏

- **WHEN** readiness auth checks find a DeepSeek credential
- **THEN** the result includes credential reference id, source class, redaction class, and availability status without the raw credential value
- **中文** 当 readiness auth checks 找到 DeepSeek credential 时，结果必须包含 credential reference id、source class、redaction class 和 availability status，但不包含 raw credential value。

#### Scenario: Missing credential is actionable / 缺少凭证可操作

- **WHEN** readiness auth checks do not find a DeepSeek credential
- **THEN** the result reports a warning with setup instructions that do not require storing secrets in tracked files
- **中文** 当 readiness auth checks 未找到 DeepSeek credential 时，结果必须报告 warning，并提供不要求把 secrets 存入 tracked files 的 setup instructions。

### Requirement: Durable Credential Reference Storage / 持久凭证引用存储

Credential auth management SHALL provide durable credential reference storage through host-injected secure-storage adapters while preventing raw secret values from entering config, command output, traces, test fixtures, or model provider adapters.

credential auth management 必须通过 host-injected secure-storage adapters 提供持久 credential reference storage，同时防止 raw secret values 进入 config、command output、traces、test fixtures 或 model provider adapters。

#### Scenario: Auth stores credential through adapter / auth 通过 adapter 存储凭证

- **WHEN** `deepseek auth` receives a DeepSeek API key or token from an explicit user input path
- **THEN** credential-auth-management stores the raw value only through the configured credential storage adapter and returns a credential reference id, source, scope, rotation metadata, and redaction metadata
- **中文** 当 `deepseek auth` 通过显式用户输入路径收到 DeepSeek API key 或 token 时，credential-auth-management 必须只通过配置的 credential storage adapter 存储 raw value，并返回 credential reference id、source、scope、rotation metadata 和 redaction metadata。

#### Scenario: Auth output never prints raw credential / auth 输出永不打印原始凭证

- **WHEN** auth, config, doctor, live verification, model gateway, logs, traces, snapshots, or assertion messages refer to a stored credential
- **THEN** they include only credential reference metadata and redacted summaries, never the raw credential value
- **中文** 当 auth、config、doctor、live verification、model gateway、logs、traces、snapshots 或 assertion messages 引用已存储凭证时，只能包含 credential reference metadata 和 redacted summaries，绝不能包含 raw credential value。

### Requirement: Credential Storage Adapter Contract / 凭证存储适配器契约

Credential auth management SHALL define secure-storage adapter contracts for storing, resolving, deleting, listing, and auditing credential references with deterministic fake implementations for tests.

credential auth management 必须定义 secure-storage adapter contracts，用于 store、resolve、delete、list 和 audit credential references，并提供 tests 使用的 deterministic fake implementations。

#### Scenario: Missing secure storage has safe fallback / 缺少安全存储时安全降级

- **WHEN** the host platform cannot provide secure credential storage
- **THEN** credential-auth-management returns a structured unavailable or degraded-storage diagnostic and does not silently store raw credentials in general config
- **中文** 当 host platform 无法提供 secure credential storage 时，credential-auth-management 必须返回 structured unavailable 或 degraded-storage diagnostic，且不得静默把 raw credentials 存入普通 config。

#### Scenario: Logout removes scoped credential / logout 删除限定范围凭证

- **WHEN** `deepseek auth logout` or an equivalent command deletes a DeepSeek credential reference
- **THEN** credential-auth-management removes only credentials in the requested provider/profile/workspace scope and emits redacted audit metadata
- **中文** 当 `deepseek auth logout` 或等价命令删除 DeepSeek credential reference 时，credential-auth-management 必须只删除请求的 provider/profile/workspace scope 内的凭证，并输出 redacted audit metadata。

### Requirement: Credential Resolution For Live Provider / live provider 凭证解析

Credential auth management SHALL resolve DeepSeek credential references for model-gateway live verification through injected resolvers rather than direct provider environment reads.

credential auth management 必须通过 injected resolvers 为 model-gateway live verification 解析 DeepSeek credential references，而不是让 provider 直接读取环境。

#### Scenario: Provider receives credential value only at boundary / provider 只在边界收到凭证值

- **WHEN** model-gateway performs an explicit live DeepSeek request
- **THEN** the credential resolver provides the raw credential only to the transport boundary and redacts it from request metadata, runtime events, diagnostics, and errors
- **中文** 当 model-gateway 执行显式 DeepSeek live request 时，credential resolver 只能把 raw credential 提供给 transport boundary，并必须从 request metadata、runtime events、diagnostics 和 errors 中脱敏。

### Requirement: Extension Credential Scope Diagnostics / 扩展凭证作用域诊断

Credential auth management SHALL expose metadata-only diagnostics for provider, plugin, MCP connector, skill, and extension credential scopes without resolving raw credential values.

Credential auth management 必须为 provider、plugin、MCP connector、skill 和 extension credential scopes 暴露 metadata-only diagnostics，且不解析 raw credential values。

#### Scenario: Scope diagnostic is metadata-only / 作用域诊断仅含元数据
- **WHEN** CLI extension management requests credential scope diagnostics
- **THEN** the credential service returns reference id, scope, source class, availability, storage status, audit metadata, redaction metadata, and suggested actions without raw secret values
- **中文** 当 CLI extension management 请求 credential scope diagnostics 时，credential service 必须返回 reference id、scope、source class、availability、storage status、audit metadata、redaction metadata 和 suggested actions，且不包含 raw secret values。

#### Scenario: Connector scope denial is typed / Connector 作用域拒绝有类型
- **WHEN** an MCP or plugin connector requests a credential reference outside its declared permissions
- **THEN** credential diagnostics report a typed scope-denied result with audit metadata and do not call `resolve`
- **中文** 当 MCP 或 plugin connector 请求超出声明 permissions 的 credential reference 时，credential diagnostics 必须报告 typed scope-denied result 与 audit metadata，且不调用 `resolve`。

### Requirement: Extension Auth Redaction Pit Evidence / 扩展认证脱敏坑位证据

Credential diagnostics used by extension management SHALL cite environment snapshot and diagnostic redaction pit fixtures when serializing credential presence or unavailable storage evidence.

Extension management 使用的 credential diagnostics 在序列化 credential presence 或 unavailable storage evidence 时，必须引用 environment snapshot 与 diagnostic redaction 坑位 fixtures。

#### Scenario: Env presence cites immutable snapshot pit / 环境存在性引用不可变快照坑位
- **WHEN** credential diagnostics observe environment credential presence
- **THEN** output records only presence metadata and cites `pit.env-snapshot.immutable-startup`
- **中文** 当 credential diagnostics 观察到环境凭证存在性时，输出必须只记录 presence metadata，并引用 `pit.env-snapshot.immutable-startup`。

#### Scenario: Credential diagnostics are safe to serialize / 凭证诊断可安全序列化
- **WHEN** tests serialize extension auth diagnostics
- **THEN** the result excludes raw credential values and cites `pit.diagnostic-redaction.support-bundle`
- **中文** 当测试序列化 extension auth diagnostics 时，结果必须排除 raw credential values，并引用 `pit.diagnostic-redaction.support-bundle`。

### Requirement: Extension Scoped Credential Grants / 扩展作用域凭证 Grant

Credential auth management SHALL create, list, revoke, diagnose, and authorize scoped credential grants for extension owners while keeping raw credential resolution behind credential storage adapters.

Credential auth management 必须为 extension owners 创建、列出、撤销、诊断并授权 scoped credential grants，同时将 raw credential resolution 保持在 credential storage adapters 之后。

#### Scenario: Grant creation returns metadata only / 创建 Grant 仅返回元数据

- **WHEN** a host-mediated auth flow creates a grant for an MCP server or plugin contribution
- **THEN** credential auth management stores only the necessary reference metadata and returns a grant record with credential reference id, owner scope, operation scope, redaction metadata, audit metadata, and replay fingerprint
- **中文** 当 host-mediated auth flow 为 MCP server 或 plugin contribution 创建 grant 时，credential auth management 必须只存储必要 reference metadata，并返回 grant record，包含 credential reference id、owner scope、operation scope、redaction metadata、audit metadata 与 replay fingerprint。

#### Scenario: Revoke grant prevents later authorization / 撤销 Grant 阻止后续授权

- **WHEN** a scoped grant is revoked
- **THEN** later authorization requests using that grant return typed revoked diagnostics and do not resolve raw credentials
- **中文** 当 scoped grant 被撤销时，后续使用该 grant 的 authorization requests 必须返回 typed revoked diagnostics，且不解析 raw credentials。

### Requirement: Extension Auth Diagnostics Remain Metadata-Only / 扩展认证诊断仅保留元数据

Credential auth diagnostics for MCP/plugin extension workflows SHALL report readiness, missing grants, denied scopes, storage availability, and suggested actions without resolving raw credential values.

MCP/plugin extension workflows 的 credential auth diagnostics 必须报告 readiness、missing grants、denied scopes、storage availability 与 suggested actions，且不解析 raw credential values。

#### Scenario: Diagnostic does not call resolve / 诊断不调用 Resolve

- **WHEN** CLI or a host requests extension auth readiness for a plugin or MCP manifest
- **THEN** credential auth management returns metadata-only diagnostics and does not call raw credential resolution
- **中文** 当 CLI 或 host 请求 plugin 或 MCP manifest 的 extension auth readiness 时，credential auth management 必须返回 metadata-only diagnostics，且不调用 raw credential resolution。

### Requirement: GLM Credential Loading / GLM 凭据加载

Credential handling for GLM live provider flows SHALL load credentials from process environment or a local `.env` file as scoped secret references without adding `.env` contents to traces, test fixtures, or committed files.

GLM live provider flows 的 credential handling 必须从 process environment 或本地 `.env` 文件加载 credentials，并作为 scoped secret references 使用，不得把 `.env` 内容加入 traces、test fixtures 或 committed files。

#### Scenario: Environment credentials take precedence / 环境变量凭据优先

- **WHEN** both process environment and `.env` contain a GLM credential
- **THEN** the process environment value is used and represented as a secret credential reference
- **中文** 当 process environment 和 `.env` 都包含 GLM credential 时，必须使用 process environment 值，并表示为 secret credential reference。

#### Scenario: Secret values are not serialized / Secret values 不被序列化

- **WHEN** live GLM smoke or CLI flow reports events, diagnostics, or failures
- **THEN** output does not contain raw API keys, `x-api-key` values, authorization headers, or full request bodies
- **中文** 当 live GLM smoke 或 CLI flow 报告 events、diagnostics 或 failures 时，输出不得包含 raw API keys、`x-api-key` values、authorization headers 或完整 request bodies。
