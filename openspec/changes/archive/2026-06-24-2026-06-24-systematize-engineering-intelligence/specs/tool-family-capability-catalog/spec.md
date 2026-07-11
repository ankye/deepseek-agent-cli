## ADDED Requirements

### Requirement: Tool Projection Explains Visibility / 工具投影解释可见性

The tool family capability catalog SHALL support projection evidence that explains why a capability is visible, hidden, denied, unavailable, stage-gated, or provider-incompatible for the current profile and stage.

工具族能力目录必须支持 projection evidence，用于解释当前 profile 与 stage 下某个 capability 为什么可见、隐藏、拒绝、不可用、被阶段 gate，或与 provider 不兼容。

#### Scenario: Hidden tools are diagnosable / 隐藏工具可诊断

- **WHEN** a tool is not projected to the model
- **THEN** projection evidence SHALL include its capability id or family id, hidden reason, policy/profile/stage source, and whether the issue is a CLI capability gap, deliberate boundary, platform unavailability, or provider compatibility limit
- **中文** 当某个工具未投影给模型时，projection evidence 必须包含其 capability id 或 family id、hidden reason、policy/profile/stage source，以及该问题是 CLI 能力缺口、刻意边界、平台不可用，还是 provider compatibility limit。
