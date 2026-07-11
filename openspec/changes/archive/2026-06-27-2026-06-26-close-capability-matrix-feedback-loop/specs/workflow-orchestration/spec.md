## ADDED Requirements

### Requirement: Read-only Task Workflow Routing

The CLI SHALL route read-only analysis, localization, and architecture-inspection prompts to a read-only workflow/profile surface that can complete through read/search/diff evidence without requiring mutation or implementation-stage progress.

CLI 必须将只读分析、定位和架构检查类 prompt 路由到只读 workflow/profile，使其可以通过 read/search/diff evidence 完成，而不要求 mutation 或实现阶段推进。

#### Scenario: Read-only analysis avoids engineering implementation workflow

- **GIVEN** a prompt asks to analyze, locate, or inspect repository architecture without editing files
- **WHEN** the CLI assembles runtime workflow guidance
- **THEN** the selected profile SHALL not require implementation-stage mutation progress
- **AND** read/search/glob/diff evidence SHALL be sufficient to advance the workflow

- **中文** 给定 prompt 要求分析、定位或检查仓库架构且不要编辑文件；当 CLI 组装 runtime workflow guidance 时，所选 profile 不得要求实现阶段 mutation progress；read/search/glob/diff evidence 必须足以推进 workflow。

