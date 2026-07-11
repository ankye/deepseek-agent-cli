## MODIFIED Requirements

### Requirement: Resource Locks

The concurrency orchestrator SHALL provide resource locks for workspace, file path, session, agent instance, process slot, model provider, and extension loading resources. Workspace, path, and process cwd locks SHALL be normalized by path segment so a directory lock conflicts with any descendant file or directory lock while sibling files remain independent. Non-path resource lock keys such as session, agent instance, model provider, MCP connection, hook execution, and remote transport locks SHALL retain literal identity and must not be path-normalized into false conflicts. Process cwd locks SHALL conflict with overlapping workspace mutation locks so tests and shell commands cannot observe or mutate half-written workspace state.

concurrency orchestrator 必须为 workspace、file path、session、agent instance、process slot、model provider 和 extension loading resources 提供 resource locks。workspace、path 与 process cwd locks 必须按路径段规范化：目录锁必须与任意子文件或子目录锁冲突，但兄弟文件仍保持独立。session、agent instance、model provider、MCP connection、hook execution、remote transport 等非路径 resource lock key 必须保持字面身份，不得被路径规范化成误冲突。process cwd locks 必须与重叠的 workspace mutation locks 冲突，避免测试和 shell command 观察或修改半写入状态。

Workspace path identity SHALL come from the platform path resolver when a governed workspace root is available, including host filesystem semantics such as case sensitivity. The concurrency orchestrator and runtime pipeline SHALL consume the platform-resolved relative path for lock keys and must not duplicate platform-specific filesystem rules in scheduling logic.

当存在受治理的 workspace root 时，workspace path identity 必须来自 platform path resolver，包括大小写敏感等宿主文件系统语义。concurrency orchestrator 与 runtime pipeline 必须消费 platform 解析后的 relative path 作为 lock key，不得在 scheduling logic 中重复实现平台相关文件系统规则。

#### Scenario: File mutation uses path lock

- **WHEN** a capability proposes or applies a file mutation
- **THEN** it acquires the required workspace or path lock before mutation
- **AND** concurrent conflicting mutations are queued, rejected, or serialized according to policy

#### Scenario: Directory and child file locks conflict

- **WHEN** one executable task holds a workspace or path lock for `src`
- **AND** another executable task requests a workspace or path lock for `src/index.ts`
- **THEN** the orchestrator treats the locks as conflicting and serializes or rejects the second task according to the caller policy
- **AND** a parallel pipeline rejects the overlapping steps before executing either mutation
- **中文** 当一个任务持有 `src` 的 workspace/path 锁，而另一个任务请求 `src/index.ts` 的 workspace/path 锁时，orchestrator 必须将它们视为冲突，并按调用方策略串行或拒绝；parallel pipeline 必须在执行任何 mutation 前拒绝重叠步骤。

#### Scenario: Sibling file locks stay independent

- **WHEN** one executable task requests a workspace or path lock for `src/a.ts`
- **AND** another executable task requests a workspace or path lock for `src/b.ts`
- **THEN** the orchestrator does not treat the locks as conflicting solely because they share the same parent directory
- **中文** 当两个任务分别请求 `src/a.ts` 与 `src/b.ts` 的 workspace/path 锁时，orchestrator 不得仅因为它们共享父目录就判定冲突。

#### Scenario: One step may declare overlapping self locks

- **WHEN** a single pipeline step declares an explicit directory lock such as `path:src`
- **AND** the same step's write input infers a descendant file lock such as `workspace:src/index.ts`
- **THEN** the pipeline does not reject the step as a parallel conflict with itself
- **AND** conflict detection compares the step's normalized lock set only with locks held by other parallel steps
- **中文** 当单个 pipeline step 同时声明 `path:src` 之类的目录锁，并且写入 input 推导出 `workspace:src/index.ts` 之类的子文件锁时，pipeline 不得把该 step 判定为与自身并行冲突；冲突检测只应将该 step 的规范化锁集合与其他并行 step 的锁比较。

#### Scenario: Patch mutation locks target files

- **WHEN** a write capability receives a unified diff patch payload
- **THEN** the execution envelope infers workspace locks for each normalized patch target path
- **AND** patch mutations for the same target file conflict with file edit/write mutations for that target
- **中文** 当写能力收到 unified diff patch payload 时，execution envelope 必须为每个规范化 patch target path 推导 workspace locks；同一目标文件的 patch mutation 必须与该文件的 file edit/write mutation 冲突。

#### Scenario: Unknown write target locks workspace root

- **WHEN** a write capability cannot expose a concrete path before execution
- **THEN** the execution envelope acquires a workspace-root lock such as `workspace:.`
- **AND** the capability does not run concurrently with known file writes in the same workspace
- **中文** 当写能力在执行前无法暴露具体路径时，execution envelope 必须获取 `workspace:.` 之类的工作区根锁，且不得与同一工作区内的已知文件写并发执行。

#### Scenario: Process cwd and workspace mutation locks conflict

- **WHEN** one executable task holds a process cwd lock such as `process:.` or `process-slot:packages/a`
- **AND** another executable task requests a workspace/path mutation lock for the same directory, the same path, or a descendant path
- **THEN** the orchestrator treats the locks as conflicting and serializes or rejects the second task according to the caller policy
- **AND** a parallel pipeline rejects the overlapping process and mutation steps before executing either step
- **AND** process cwd locks for one sibling directory do not conflict solely with workspace mutation locks for another sibling directory
- **中文** 当一个任务持有 `process:.` 或 `process-slot:packages/a` 之类的 process cwd lock，而另一个任务请求同目录、同路径或子路径的 workspace/path mutation lock 时，orchestrator 必须将它们视为冲突，并按调用方策略串行或拒绝；parallel pipeline 必须在执行任一步骤前拒绝重叠的 process 与 mutation steps；一个兄弟目录上的 process cwd lock 不得仅因为共享父目录就与另一个兄弟目录的 workspace mutation lock 冲突。

#### Scenario: One execution coalesces overlapping self locks

- **WHEN** one executable envelope infers or declares multiple resource locks that overlap each other, such as `workspace:src` and `workspace:src/index.ts`
- **OR** one executable envelope contains an overlapping process/workspace pair for the same path tree
- **THEN** the runtime coalesces the self-overlapping lock set before acquiring scheduler locks
- **AND** the execution does not wait on its own lock chain or time out due to self-deadlock
- **AND** distinct sibling locks remain distinct so unrelated sibling writes are not collapsed
- **中文** 当同一个 executable envelope 推导或声明多个彼此重叠的 resource locks，例如 `workspace:src` 与 `workspace:src/index.ts`，或包含同一路径树上的 process/workspace 重叠锁时，runtime 必须在获取 scheduler locks 前合并自身重叠 lock set；该执行不得等待自己的 lock chain 或因自锁死锁超时；不同兄弟路径的 locks 必须保持独立，不得被合并。

#### Scenario: Session workspace root defaults are lock-visible

- **WHEN** an executable process-like capability is invoked in a session whose metadata declares `workspaceRoot`
- **AND** the model-provided tool input omits both `cwd` and `workspaceRoot`
- **THEN** runtime envelope construction uses the session `workspaceRoot` as the effective workspace root for resource lock inference, policy metadata, sandbox/resource scope, and executor input
- **AND** the process capability receives a cwd lock such as `process:.` before scheduling
- **中文** 当 process-like capability 在 metadata 声明了 `workspaceRoot` 的 session 中被调用，且模型提供的 tool input 同时省略 `cwd` 与 `workspaceRoot` 时，runtime envelope construction 必须把 session `workspaceRoot` 作为 resource lock 推导、policy metadata、sandbox/resource scope 与 executor input 的有效 workspace root；process capability 在 scheduling 前必须获得 `process:.` 之类的 cwd lock。

#### Scenario: Pipeline workspace root defaults are lock-visible

- **WHEN** a pipeline has a governed `workspaceRoot`
- **AND** one or more step inputs omit both `cwd` and `workspaceRoot`
- **THEN** step resolution uses the pipeline `workspaceRoot` as the effective workspace root for inferred locks, preflight, policy metadata, sandbox/resource scope, and executor input
- **AND** parallel pipeline conflict detection rejects an omitted-root process step that overlaps a workspace mutation step
- **中文** 当 pipeline 具有受治理的 `workspaceRoot`，且一个或多个 step input 同时省略 `cwd` 与 `workspaceRoot` 时，step resolution 必须把 pipeline `workspaceRoot` 作为 inferred locks、preflight、policy metadata、sandbox/resource scope 与 executor input 的有效 workspace root；parallel pipeline conflict detection 必须拒绝省略 root 但与 workspace mutation step 重叠的 process step。

#### Scenario: Platform canonical relative paths define path lock identity

- **WHEN** the platform resolver reports case-insensitive filesystem semantics for the governed workspace
- **AND** two write or process inputs resolve to the same platform-relative path with different casing
- **THEN** runtime envelope construction, pipeline conflict detection, and policy metadata use the platform-resolved canonical relative path for the lock key
- **AND** the scheduler treats those locks as overlapping without adding platform-specific case rules of its own
- **中文** 当 platform resolver 报告受治理 workspace 的文件系统语义为大小写不敏感，且两个 write 或 process input 以不同大小写解析到同一个 platform relative path 时，runtime envelope construction、pipeline conflict detection 与 policy metadata 必须使用 platform 解析出的 canonical relative path 作为 lock key；scheduler 必须将这些 locks 视为重叠，但自身不得新增平台大小写规则。

#### Scenario: Non-path lock keys remain literal

- **WHEN** two executable tasks request non-path resource locks of the same kind with distinct literal keys
- **THEN** the orchestrator does not normalize `a/../b`, repeated slashes, or dot segments as filesystem paths
- **AND** the tasks do not conflict unless the literal normalized lock kind and literal trimmed key are equal
- **中文** 当两个任务请求同类非路径 resource locks 且 key 字面值不同时，orchestrator 不得把 `a/../b`、重复斜杠或点段按文件系统路径规范化；只有规范化后的 lock kind 与 trim 后的 key 字面值完全相等时才视为冲突。

#### Scenario: Agent instance turn is serialized

- **WHEN** the same agent instance receives multiple turn requests
- **THEN** the orchestrator serializes or rejects concurrent turns according to the agent lifecycle policy
