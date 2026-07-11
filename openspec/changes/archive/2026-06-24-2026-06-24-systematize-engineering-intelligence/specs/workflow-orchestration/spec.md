## ADDED Requirements

### Requirement: Engineering Profiles Are Workflow Contracts / 工程 Profile 是 Workflow Contract

Reusable engineering profiles SHALL be represented as staged workflow contracts with success criteria, allowed capability families, expected evidence refs, fallback blocker criteria, and decision-board projection metadata.

可复用工程 profile 必须表示为 staged workflow contracts，包含 success criteria、allowed capability families、expected evidence refs、fallback blocker criteria 与 decision-board projection metadata。

#### Scenario: Software engineer profile stages engineering work / 软件工程师 Profile 分阶段执行工程任务

- **WHEN** the `software-engineer` profile is active for a coding task
- **THEN** the workflow SHALL include understand, plan, change, verify, and report stages
- **AND** each stage SHALL declare allowed tool families and required evidence before downstream stages become ready
- **AND** the runtime SHALL not mark stage success from text-only claims when required evidence refs are missing.
- **中文** 当 `software-engineer` profile 用于 coding task 时，workflow 必须包含 understand、plan、change、verify 与 report 阶段；每个阶段必须声明 allowed tool families 与下游阶段 ready 前所需 evidence；当缺少必需 evidence refs 时，runtime 不得仅根据文本声明标记阶段成功。
