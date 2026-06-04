## ADDED Requirements

### Requirement: Offline Default Regression / Offline 默认回归

Default regression commands SHALL NOT require GLM network access, GLM credentials, provider availability, or account balance.

默认回归命令不得要求 GLM network access、GLM credentials、provider availability 或 account balance。

#### Scenario: Default tests remain offline / 默认测试保持 offline

- **WHEN** `npm test` runs
- **THEN** GLM live provider tests are skipped unless their dedicated live gate is set
- **中文** 当 `npm test` 运行时，GLM live provider tests 必须跳过，除非设置了它们的专用 live gate。
