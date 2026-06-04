## 1. GLM Tool Input Normalization / GLM 工具输入规范化

- [x] 1.1 Add a failing regression test for GLM tool calls that emit `{ "raw": "<json-object>" }`. / 增加失败回归测试，覆盖 GLM tool calls 输出 `{ "raw": "<json-object>" }` 的情况。
- [x] 1.2 Normalize single-field raw JSON object tool inputs without changing opaque raw-string fallback behavior. / 规范化单字段 raw JSON object tool inputs，同时不改变 opaque raw-string fallback 行为。

## 2. GLM Webpage Evaluation Budget / GLM 网页评测预算

- [x] 2.1 Add focused CLI model-selection coverage for expanded webpage/html prompts. / 增加聚焦 CLI model-selection 覆盖，验证 expanded webpage/html prompts。
- [x] 2.2 Apply larger GLM Anthropic `max_tokens` and wider one-shot agent-loop limits only for expanded webpage/html tasks. / 仅对 expanded webpage/html tasks 应用更大的 GLM Anthropic `max_tokens` 与 one-shot agent-loop limits。

## 3. Webpage Final Response Contract / 网页最终回复契约

- [x] 3.1 Add prompt coverage requiring a short fixed final response for webpage evaluation tasks. / 增加 prompt 覆盖，要求 webpage evaluation tasks 使用固定短句最终回复。
- [x] 3.2 Keep artifact evidence in `generated-webpage/evidence.json` and prevent final-summary command/product recaps. / 将 artifact evidence 保持在 `generated-webpage/evidence.json`，并避免 final summary 复述 command/product claims。

## 4. Verification / 验证

- [x] 4.1 Validate OpenSpec change and run focused tests. / 校验 OpenSpec change 并运行聚焦测试。
- [x] 4.2 Rerun GLM live webpage evaluation and confirm `eval.webpage.generation` solves. / 重新运行 GLM live webpage evaluation，并确认 `eval.webpage.generation` solved。
- [x] 4.3 Run repository verification suite before commit. / 提交前运行仓库验证套件。
