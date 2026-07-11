## ADDED Requirements

### Requirement: Acceptance Is Evidence-Gated / 验收由证据 Gate 控制

CLI task completion evaluation SHALL require contract-specific evidence before marking a task pass. A final text answer, a transient correction event, or an implementation test result alone SHALL NOT be sufficient for pass classification.

CLI task completion evaluation 在标记任务通过前必须要求符合契约的证据。最终文本、中间纠错事件或单个实现测试结果本身不得作为 pass classification 的充分条件。

#### Scenario: Nontrivial pass cites commands and probes / 非平凡通过引用命令和探针

- **WHEN** a supervised task involves implementation, artifact delivery, shell execution, or workflow orchestration
- **THEN** pass classification SHALL cite bounded command/output evidence
- **AND** SHOULD include at least one meaningful adversarial probe result when practical
- **AND** terminal/final outcome evidence SHALL take precedence over transient recovery events when classifying failure causes.
- **中文** 当监督任务涉及实现、artifact 交付、shell 执行或 workflow 编排时，pass classification 必须引用有界命令/输出证据；可行时应包含至少一个有意义的对抗性探针结果；分类失败原因时，terminal/final outcome evidence 必须优先于中间 recovery events。
