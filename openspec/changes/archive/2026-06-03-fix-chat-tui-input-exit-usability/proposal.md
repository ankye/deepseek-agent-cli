## Why

Raw chat TUI input currently has several usability and safety defects: command-bar key events can leak into prompt text, unmatched command queries can accidentally submit model input, and compact/full-screen rendering can make the active input anchor hard to see. These issues make local TUI controls feel unpredictable during normal chat use.

当前 raw chat TUI input 存在若干可用性与安全缺陷：command-bar 按键可能泄漏到 prompt text，无匹配 command query 可能误提交 model input，compact/full-screen rendering 也可能让当前 input anchor 难以识别。这会让本地 TUI controls 在日常 chat 使用中变得不可预测。

## What Changes

- Keep slash command-bar editing local unless a command bridge explicitly returns `insertText` or `submitText`. / 除非 command bridge 明确返回 `insertText` 或 `submitText`，否则 slash command-bar 编辑必须保持本地化。
- Preserve panel-aware Tab behavior: command-bar suggestions when the bar is open, panel focus when it is closed. / 保持 panel-aware Tab 行为：command-bar 打开时导航 suggestions，关闭时切换 panel focus。
- Render compact line-mode summaries with bounded, explicit sections. / 使用有界且区域明确的 compact line-mode summary 渲染。
- Keep raw and full-screen input anchors visibly updated while typing, including long mixed-language text and bracketed multiline paste. / 在输入时持续更新 raw 与 full-screen input anchors，包括超长混合语言文本和 bracketed multiline paste。
- Ensure full-screen raw repaints overwrite stable frames without per-key clear-screen flicker. / 确保 full-screen raw repaint 覆盖稳定 frame，不在每次按键时清屏闪烁。

## Capabilities

### New Capabilities

- `chat-tui-input-exit-usability`: specify raw chat TUI input, command-bar, exit, paste, and repaint behavior. / 规定 raw chat TUI input、command-bar、exit、paste 与 repaint 行为。

### Modified Capabilities

None. / 无。

## Impact

- Affects `src/apps/cli/src/input/chat-input.ts`, chat raw-input dispatch, and chat TUI workbench renderers. / 影响 `src/apps/cli/src/input/chat-input.ts`、chat raw-input dispatch 与 chat TUI workbench renderers。
- Adds focused contract, regression, integration, and golden coverage for raw TUI behavior. / 增加 raw TUI 行为的聚焦 contract、regression、integration 与 golden coverage。
- Keeps non-raw line input and TUI-disabled chat behavior compatible. / 保持 non-raw line input 与禁用 TUI 的 chat 行为兼容。
