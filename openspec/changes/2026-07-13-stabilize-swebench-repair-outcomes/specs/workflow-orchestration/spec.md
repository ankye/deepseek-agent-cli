## ADDED Requirements

### Requirement: Mutation Recovery Is Targeted And Bounded / Mutation 恢复必须定向且有界

The workflow runtime SHALL allow one bounded refresh of the same target file after a typed exact-match mutation precondition failure, even when ordinary source-inspection budget is exhausted. It SHALL return to mutation after that refresh and SHALL classify repeated or wrong-target refresh as flow-control exhaustion rather than user-approval need.

Workflow runtime 必须在 typed exact-match mutation precondition failure 后允许对同一目标文件进行一次 bounded refresh，即使普通 source-inspection budget 已耗尽。刷新后必须返回 mutation；重复或错目标刷新必须归类为 flow-control exhaustion，而不是需要用户授权。

#### Scenario: Exact edit context is stale / Exact Edit 上下文过期

- **WHEN** a governed `core.file.edit` fails with typed exact-match precondition evidence for path `P`
- **AND** the active stage has exhausted ordinary focused-read budget
- **THEN** the next model request may use one bounded `core.file.read` for path `P`
- **AND** after that read the required next action is `core.file.edit|core.patch.apply`
- **AND** a second read or a read of another path terminates with `FLOW_MUTATION_RECOVERY_EXHAUSTED`
- **中文** 当受治理的 `core.file.edit` 因路径 `P` 的 typed exact-match precondition evidence 失败，且当前 stage 已耗尽普通 focused-read budget 时，下一次模型请求可以对路径 `P` 执行一次 bounded `core.file.read`；该读取后 required next action 必须为 `core.file.edit|core.patch.apply`；第二次读取或读取其他路径必须以 `FLOW_MUTATION_RECOVERY_EXHAUSTED` 终止。

### Requirement: SWE Verification Uses A Problem Behavior Contract / SWE 验证使用问题行为契约

The governed SWE child workflow SHALL carry a host-owned behavior-contract reference derived from the problem statement. Successful public repository tests alone SHALL NOT close initial verification until a safe non-mutating behavior reproduction has completed. This requirement SHALL NOT affect workflows without the SWE behavior-contract reference.

受治理的 SWE child workflow 必须携带一个从 problem statement 派生的 host-owned behavior-contract reference。在安全无写入行为复现完成前，仅成功的 public repository tests 不得关闭初始 verification。本要求不得影响缺少 SWE behavior-contract reference 的 workflows。

#### Scenario: Public tests pass before task-specific reproduction / 任务特定复现前 Public Tests 通过

- **WHEN** the initial SWE child attempt has a behavior-contract reference
- **AND** a public repository test succeeds
- **AND** no safe governed reproduction derived from the problem statement has completed
- **THEN** verification remains open and requests the reproduction
- **AND** after the reproduction completes, the workflow may accept the narrowest public verification as closure evidence
- **中文** 当初始 SWE child attempt 拥有 behavior-contract reference，public repository test 成功，但尚未完成从 problem statement 派生的安全受治理复现时，verification 必须保持开放并要求该复现；复现完成后，workflow 可以接受最窄 public verification 作为关闭证据。

### Requirement: Supervised SWE Attempts Preserve The Best Candidate / Supervised SWE Attempts 保留最佳候选

The SWE runner SHALL persist immutable per-attempt patch, prediction, trace, and evaluation evidence. It SHALL rank candidates using official observable outcomes and SHALL restore the best candidate before further repair when the latest candidate regresses. An attempt without a valid harness report SHALL NOT replace a harness-scored candidate.

SWE runner 必须持久化不可变的逐 attempt patch、prediction、trace 和 evaluation evidence。它必须使用官方可观测 outcome 排序候选，并在最新候选退化时，在后续 repair 前恢复最佳候选。没有有效 harness report 的 attempt 不得替换 harness-scored 候选。

#### Scenario: Later repair regresses and final attempt is not harness-ready / 后续修复退化且最后 Attempt 未达 Harness Readiness

- **WHEN** attempt 1 has a valid unresolved harness report with zero pass-to-pass failures
- **AND** attempt 2 has more pass-to-pass failures
- **AND** attempt 3 does not reach harness readiness
- **THEN** attempt 1 remains `bestAttempt`
- **AND** the returned patch and authoritative evaluation come from attempt 1
- **AND** attempt 3 remains `lastAttempt` with its terminal diagnostics
- **中文** 当 attempt 1 拥有零 pass-to-pass failure 的有效 unresolved harness report，attempt 2 拥有更多 pass-to-pass failures，且 attempt 3 未达 harness readiness 时，attempt 1 必须保持为 `bestAttempt`；返回 patch 和权威 evaluation 必须来自 attempt 1；attempt 3 必须保持为携带终态 diagnostics 的 `lastAttempt`。
