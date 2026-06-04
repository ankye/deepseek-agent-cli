# architecture-scale-guardrails Specification

## Purpose
Define architecture scale guardrails that keep package boundaries, file size, import direction, and roadmap drift mechanically visible.

定义架构规模护栏，使 package boundaries、文件规模、import direction 与 roadmap drift 可被机械化发现。
## Requirements
### Requirement: CLI Host Modules Remain Thin / CLI Host 模块保持轻量

The CLI host SHALL split process startup, argument parsing, command adapters, terminal input, renderers, host wiring, and diagnostics into dedicated modules while preserving existing user-visible behavior.

CLI host 必须将 process startup、argument parsing、command adapters、terminal input、renderers、host wiring 和 diagnostics 拆入专门模块，同时保持现有用户可见行为。

#### Scenario: CLI entry delegates to host modules / CLI 入口委托给 host 模块

- **WHEN** `src/apps/cli/src/index.ts` is loaded as the CLI executable or package entry
- **THEN** it delegates to dedicated CLI host modules and does not contain the primary implementations for command handling, rendering, input handling, diagnostics, or runtime wiring
- **中文** 当 `src/apps/cli/src/index.ts` 作为 CLI executable 或 package entry 加载时，它必须委托给专门的 CLI host 模块，不能包含 command handling、rendering、input handling、diagnostics 或 runtime wiring 的主要实现。

#### Scenario: CLI host does not own execution / CLI host 不拥有执行逻辑

- **WHEN** CLI commands trigger model, tool, policy, session, MCP, plugin, or runtime work
- **THEN** CLI modules route the request through shared contracts and owning packages rather than importing implementation internals or executable primitives directly
- **中文** 当 CLI commands 触发 model、tool、policy、session、MCP、plugin 或 runtime 工作时，CLI 模块必须通过共享契约和责任包路由请求，不得直接导入实现内部或可执行 primitive。

### Requirement: Package Index Files Are Public Surfaces / Package Index 文件是公开表面

Package `index.ts` files SHALL act as public export surfaces and small composition entrypoints, not as implementation hubs for engines, adapters, renderers, validators, or persistence.

package 的 `index.ts` 文件必须作为 public export surfaces 和小型组合入口，不得成为 engines、adapters、renderers、validators 或 persistence 的实现中心。

#### Scenario: Implementation-heavy index is split / 实现过重的 index 被拆分

- **WHEN** a package `index.ts` contains implementation-heavy logic or grows beyond the configured central-file threshold
- **THEN** implementation logic is moved into private modules while the package public exports remain source-compatible
- **中文** 当 package `index.ts` 包含过重实现逻辑或超过配置的中心文件阈值时，必须把实现逻辑移入私有模块，同时保持 package public exports 源码兼容。

#### Scenario: Public exports stay stable / 公开导出保持稳定

- **WHEN** package internals are split into private modules
- **THEN** existing package import paths documented as public exports continue to typecheck without cross-package relative imports
- **中文** 当 package internals 被拆入私有模块时，已记录为 public exports 的 package import paths 必须继续通过 typecheck，且不得引入跨 package 相对导入。

### Requirement: Architecture Scale Lint / 架构规模 Lint

The repository SHALL provide mechanical lint coverage that detects central-file growth, implementation-heavy `index.ts` files, and host-edge import boundary violations.

仓库必须提供机械化 lint 覆盖，用于识别中心文件膨胀、实现过重的 `index.ts` 文件和 host-edge import boundary 违规。

#### Scenario: Central files are flagged / 中心文件被标记

- **WHEN** a source file crosses the warning or failure threshold defined by architecture conventions
- **THEN** `npm run lint` reports the file with a stable rule id and actionable split guidance
- **中文** 当源码文件超过架构约定定义的 warning 或 failure 阈值时，`npm run lint` 必须用稳定 rule id 报告该文件，并给出可执行拆分建议。

#### Scenario: Host boundary bypass is rejected / Host 边界绕过被拒绝

- **WHEN** a CLI host module imports runtime, policy, MCP, plugin, model, or tool implementation internals in a way that bypasses `@deepseek/platform-contracts` or the owning package public export
- **THEN** the architecture lint fails with a boundary violation
- **中文** 当 CLI host 模块以绕过 `@deepseek/platform-contracts` 或责任包 public export 的方式导入 runtime、policy、MCP、plugin、model 或 tool 实现内部时，架构 lint 必须以 boundary violation 失败。

### Requirement: Directory Plan For Large Changes / 大型变更目录计划

Large product-facing or architecture-facing OpenSpec changes SHALL include a Directory Plan section before implementation.

大型面向产品或架构的 OpenSpec 变更必须在实现前包含 Directory Plan 小节。

#### Scenario: Directory plan declares ownership / 目录计划声明责任归属

- **WHEN** a future OpenSpec proposes a large CLI-facing capability or a broad package refactor
- **THEN** it declares owner packages, new folders, public exports, private modules, host-specific files, implementation-free contracts, fixture locations, test locations, and split triggers
- **中文** 当后续 OpenSpec 提出大型 CLI-facing capability 或广泛 package refactor 时，必须声明 owner packages、新目录、public exports、private modules、host-specific files、implementation-free contracts、fixture locations、test locations 和 split triggers。

#### Scenario: Missing plan blocks implementation / 缺少计划阻止实现

- **WHEN** an implementation change exceeds the configured scope or file-size thresholds without a Directory Plan
- **THEN** validation, lint, or review evidence marks the change incomplete until the plan is added
- **中文** 当实现变更超过配置的范围或文件体量阈值但缺少 Directory Plan 时，validation、lint 或 review evidence 必须将该变更标记为 incomplete，直到补充计划。

### Requirement: Behavior-Preserving Refactor Evidence / 行为保持型重构证据

This architecture split SHALL provide parity evidence proving the refactor does not change existing CLI product behavior.

本架构拆分必须提供 parity evidence，证明重构不改变现有 CLI 产品行为。

#### Scenario: Existing CLI behavior remains stable / 现有 CLI 行为保持稳定

- **WHEN** the CLI host modules and package index files are split
- **THEN** existing run, chat, text output, JSON output, JSONL output, readiness, smoke, golden, and e2e evidence remain semantically equivalent
- **中文** 当 CLI host 模块和 package index 文件被拆分后，现有 run、chat、text output、JSON output、JSONL output、readiness、smoke、golden 和 e2e 证据必须保持语义等价。

### Requirement: Planned oversized baselines are temporary
Architecture scale guardrails SHALL treat planned oversized source files as tracked split-plan debt, and SHALL remove those entries when the planned responsibility has been extracted below the configured threshold.

Architecture scale guardrails 必须将 planned oversized source files 视为被跟踪的 split-plan debt，并且在计划中的责任拆分完成且文件低于配置阈值后移除这些条目。

#### Scenario: Split-plan entry is retired after extraction
- **WHEN** a central file in `plannedOversizedFiles` has its tracked responsibility extracted into smaller owner modules and the file is below the configured central-file threshold
- **THEN** the split-plan baseline entry is removed and `npm run lint` continues to pass without the exception
- **中文** 当 `plannedOversizedFiles` 中的中心文件已将被跟踪责任拆入更小的 owner modules，且文件低于 central-file threshold 时，必须移除 split-plan baseline entry，并且 `npm run lint` 在无例外情况下继续通过。

#### Scenario: Behavior-preserving split keeps tests green
- **WHEN** a TUI central file is split only by implementation responsibility
- **THEN** existing TUI, plugin execution, palette, and workbench behavior remains covered by focused regression tests
- **中文** 当 TUI central file 仅按实现责任拆分时，现有 TUI、plugin execution、palette 与 workbench 行为必须继续由聚焦回归测试覆盖。

### Requirement: Workspace Alias Integrity / Workspace Alias 完整性

Architecture guardrails SHALL validate that every `@deepseek/*` TypeScript path alias resolves to an existing workspace package, plugin package, or explicit retired/merged governance record.

架构护栏必须校验每个 `@deepseek/*` TypeScript path alias 都解析到现有 workspace package、plugin package，或显式 retired/merged 治理记录。

#### Scenario: Missing package alias is reported / 缺失包 Alias 被报告

- **WHEN** `tsconfig.base.json` declares a path alias whose target package directory does not exist
- **THEN** architecture lint reports the alias, target path, expected package name, and whether a retired/merged governance record exists
- **中文** 当 `tsconfig.base.json` 声明的 path alias 指向不存在的 package 目录时，架构 lint 必须报告该 alias、target path、预期 package name，以及是否存在 retired/merged 治理记录。

#### Scenario: Retired alias is time-bounded / 已退役 Alias 有时间边界

- **WHEN** a missing alias is intentionally retained during migration
- **THEN** the governance record includes the replacement package, allowed consumers, removal deadline, and release-risk severity
- **中文** 当缺失 alias 在迁移期间被有意保留时，治理记录必须包含替代 package、允许消费方、移除期限和发布风险严重度。

### Requirement: Placeholder Boundary Declarations / 占位边界声明

Architecture guardrails SHALL require placeholder implementations to be exported from their owner package with explicit governance metadata rather than implying standalone product packages exist.

架构护栏必须要求占位实现从其 owner package 导出并带有显式治理元数据，而不是暗示存在独立产品 package。

#### Scenario: Placeholder has owner and blocked claims / 占位有 Owner 与阻止声明

- **WHEN** a placeholder class implements a platform contract such as remote connectivity, distribution update, extension management, or evolution
- **THEN** architecture diagnostics identify the owner package, allowed deterministic use cases, blocked product claims, and replacement trigger
- **中文** 当占位 class 实现 remote connectivity、distribution update、extension management 或 evolution 等平台契约时，架构 diagnostics 必须识别 owner package、允许的确定性用途、被阻止的产品声明和替换触发条件。

### Requirement: Planning Code Drift Checks / 规划与代码漂移检查

Architecture guardrails SHALL detect drift between package maps, roadmap status labels, OpenSpec capability states, and source/package manifests for risk-bearing capabilities.

架构护栏必须检测 package map、roadmap 状态标签、OpenSpec capability state 与 source/package manifest 在有风险能力上的漂移。

#### Scenario: Roadmap overstates implementation / 路线图夸大实现状态

- **WHEN** roadmap or package-map text marks a risk-bearing capability as implemented while source evidence only shows placeholder, deferred, or partial behavior
- **THEN** diagnostics report a planning/code drift finding with the conflicting files and the expected governance state
- **中文** 当 roadmap 或 package-map 文案将有风险能力标记为 implemented，但源码证据仅显示 placeholder、deferred 或 partial 行为时，diagnostics 必须报告 planning/code drift，包含冲突文件和预期治理状态。

#### Scenario: Implemented behavior lacks public export evidence / 实现缺少公共导出证据

- **WHEN** a package claims implemented capability status
- **THEN** architecture guardrails verify that the package exposes the public API through package imports and does not rely on cross-package private source imports
- **中文** 当 package 声称能力已实现时，架构护栏必须验证该 package 通过 package import 暴露公共 API，且不依赖跨 package 私有源码 import。

### Requirement: Kernel Boundary Lint / 内核边界 Lint

Architecture guardrails SHALL reject subsystem-owned implementation imports into runtime kernel code when a public owner-package contract exists.

当存在 public owner-package contract 时，架构护栏必须拒绝子系统所有的实现导入进入 runtime kernel code。

#### Scenario: Runtime imports owner package through public API / Runtime 通过公共 API 导入责任包

- **WHEN** runtime needs prompt assembly, context projection, memory/cache, plugin, MCP, code intelligence, policy, or model gateway behavior
- **THEN** lint allows package public imports and rejects private `src/` imports, app imports, testing fake imports, provider SDK imports, or direct host APIs
- **中文** 当 runtime 需要 prompt assembly、context projection、memory/cache、plugin、MCP、code intelligence、policy 或 model gateway 行为时，lint 必须允许 package public imports，并拒绝 private `src/` imports、app imports、testing fake imports、provider SDK imports 或直接 host APIs。

### Requirement: Central File Size Guardrails / 中心文件规模护栏

Architecture guardrails SHALL define size and ownership thresholds for runtime, app entrypoint, package export, and lint framework central files.

架构护栏必须为 runtime、app entrypoint、package export 与 lint framework 中心文件定义规模和 ownership 阈值。

#### Scenario: File exceeds threshold / 文件超过阈值

- **WHEN** a central file exceeds the configured line-count, export-count, or ownership-domain threshold
- **THEN** lint or diagnostics reports the file, detected ownership domains, and suggested extraction packages
- **中文** 当中心文件超过配置的 line-count、export-count 或 ownership-domain 阈值时，lint 或 diagnostics 必须报告该文件、检测到的 ownership domains 和建议拆分 package。

### Requirement: Runtime Kernel Guardrails / Runtime Kernel 护栏

Architecture guardrails SHALL enforce runtime kernel dependency boundaries and central-file pressure thresholds.

架构护栏必须执行 runtime kernel 依赖边界与中心文件压力阈值。

#### Scenario: Kernel boundary check is part of lint / Kernel 边界检查纳入 lint

- **WHEN** `npm run lint` or release readiness scans architecture rules
- **THEN** it reports runtime kernel imports that violate app, host, provider, test, private subsystem, or owner-package boundaries
- **中文** 当 `npm run lint` 或 release readiness 扫描架构规则时，必须报告违反 app、host、provider、test、private subsystem 或 owner-package 边界的 runtime kernel imports。

#### Scenario: Central runtime file pressure is visible / 中心 Runtime 文件压力可见

- **WHEN** runtime kernel files exceed configured size, dependency, or ownership thresholds
- **THEN** guardrails report the file, threshold, likely owner-package extraction target, severity, and follow-up action
- **中文** 当 runtime kernel 文件超过配置的规模、依赖或 ownership 阈值时，护栏必须报告文件、阈值、可能的 owner-package 抽取目标、严重度与后续动作。

### Requirement: Ghost Alias Detection / Ghost Alias 检测

Architecture guardrails SHALL detect `@deepseek/*` path aliases that do not resolve to existing workspace packages, plugin packages, or explicit retired/merged governance records.

架构护栏必须检测无法解析到现有 workspace packages、plugin packages 或显式 retired/merged governance records 的 `@deepseek/*` path aliases。

#### Scenario: Missing package alias is reported / 缺失 Package Alias 被报告

- **WHEN** `tsconfig.base.json` declares an alias whose target package directory does not exist
- **THEN** lint reports the alias, target path, expected owner, severity, and whether a retired/merged record exists
- **中文** 当 `tsconfig.base.json` 声明的 alias 目标 package 目录不存在时，lint 必须报告 alias、target path、expected owner、severity 与是否存在 retired/merged record。

### Requirement: Placeholder Ownership Guardrail / Placeholder Ownership 护栏

Architecture guardrails SHALL report placeholder implementations that lack owner, allowed consumers, blocked product claims, and replacement triggers.

架构护栏必须报告缺少 owner、allowed consumers、blocked product claims 与 replacement triggers 的 placeholder implementations。

#### Scenario: Placeholder lacks promotion gate / Placeholder 缺少推广门禁

- **WHEN** a placeholder implementation is exported or used in runtime assembly
- **THEN** diagnostics require owner metadata, allowed consumer list, blocked claim list, replacement trigger, and acceptance evidence gate
- **中文** 当 placeholder implementation 被导出或用于 runtime assembly 时，diagnostics 必须要求 owner metadata、allowed consumer list、blocked claim list、replacement trigger 与 acceptance evidence gate。

### Requirement: Roadmap And Package Drift Detection / Roadmap 与 Package 漂移检测

Architecture guardrails SHALL compare roadmap labels, package-map ownership, workspace manifests, and source evidence for risk-bearing capabilities.

架构护栏必须对比有风险能力的 roadmap labels、package-map ownership、workspace manifests 与 source evidence。

#### Scenario: Roadmap overstates implementation / Roadmap 夸大实现状态

- **WHEN** roadmap marks a capability as implemented but source evidence shows placeholder, deferred, missing package, or missing evidence status
- **THEN** readiness reports a drift finding and blocks product-ready claims depending on the overstated status
- **中文** 当 roadmap 将能力标记为 implemented，但源码证据显示 placeholder、deferred、missing package 或 missing evidence 状态时，readiness 必须报告 drift finding，并阻止依赖该夸大状态的产品就绪声明。

### Requirement: Provider Internal Import Guardrail / Provider Internal Import Guardrail

Application hosts, runtime packages, and non-model-gateway packages SHALL NOT import model-gateway provider internal implementation paths after provider adapters are split into vendor/protocol directories.

provider adapters 拆入 vendor/protocol directories 后，application hosts、runtime packages 与 non-model-gateway packages 不得 import model-gateway provider internal implementation paths。

#### Scenario: Package root is the only external provider import boundary / Package root 是唯一外部 provider import 边界

- **WHEN** a non-model-gateway package needs a model provider class, profile, transport, or credential ref
- **THEN** it imports from `@deepseek/model-gateway` rather than `@deepseek/model-gateway/providers/...` or cross-package relative paths
- **中文** 当 non-model-gateway package 需要 model provider class、profile、transport 或 credential ref 时，必须从 `@deepseek/model-gateway` import，而不是从 `@deepseek/model-gateway/providers/...` 或 cross-package relative paths import。

#### Scenario: Lint or boundary check protects adapter internals / Lint 或 boundary check 保护 adapter internals

- **WHEN** an implementation introduces an external import of provider internal adapter files
- **THEN** `npm run lint` or `node scripts/check-boundaries.mjs` fails before the change is accepted
- **中文** 当 implementation 引入对 provider internal adapter files 的外部 import 时，`npm run lint` 或 `node scripts/check-boundaries.mjs` 必须在 change 被接受前失败。

