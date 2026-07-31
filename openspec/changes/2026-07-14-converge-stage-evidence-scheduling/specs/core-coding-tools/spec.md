## ADDED Requirements

### Requirement: Focused Search Returns Actionable Content Evidence / Focused Search 返回可操作内容证据

Core search preflight SHALL normalize a search executed inside a governed focused evidence window to content output, even when the model omits `outputMode`. Ordinary searches outside focused recovery SHALL preserve their existing default behavior.

Core search preflight 必须把受治理 focused evidence window 内执行的搜索归一化为 content output，即使模型省略 `outputMode`。Focused recovery 之外的普通搜索必须保留现有默认行为。

#### Scenario: Focused search omits output mode / Focused Search 省略 Output Mode

- **WHEN** `core.search.text` is admitted by a governed focused evidence window
- **AND** the model supplies a pattern and glob but omits `outputMode`
- **THEN** preflight executes the search with `outputMode: "content"`
- **AND** result metadata exposes deterministic matching path, line, and content identity for progress evaluation
- **中文** 当 `core.search.text` 被受治理 focused evidence window 接纳，模型提供 pattern 与 glob 但省略 `outputMode` 时，preflight 必须以 `outputMode: "content"` 执行搜索；result metadata 必须暴露确定性的 matching path、line 与 content identity，供进展评估使用。
