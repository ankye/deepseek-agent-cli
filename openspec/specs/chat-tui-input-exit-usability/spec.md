# chat-tui-input-exit-usability Specification

## Purpose
Define the usability contract for the chat TUI input loop: slash command entry, raw prompt editing, full-screen repaint behavior, bracketed paste, and exit handling must stay local, visible, bounded, and deterministic across CLI terminal profiles.

定义 chat TUI 输入循环的可用性契约：slash command 输入、raw prompt 编辑、全屏重绘、bracketed paste 与退出处理，必须在 CLI 终端画像中保持本地化、可见、有界且确定。
## Requirements
### Requirement: Command-Bar Opens Only When Input Buffer Is Empty / Command-Bar 仅在输入缓冲为空时打开

When pending prompt text is empty, pressing `/` in prompt mode SHALL open the command bar without buffering `/` in raw prompt text. When pending prompt text is non-empty, `/` SHALL be buffered as normal prompt text.

当提示文本 pending 为空时，在 prompt 模式按 `/` 必须打开 command bar 且不把 `/` 写入 raw prompt text。当 pending prompt text 非空时，`/` 必须作为普通 prompt text 写入。

#### Scenario: Slash opens command-bar and does not pollute prompt buffer / Slash 打开 Command-Bar 且不污染 Prompt 缓冲
- **WHEN** prompt pending is `""` and the user presses `/`
- **THEN** the command bar opens, `pending` remains `""`, and no immediate prompt output is emitted
- **中文** 当 prompt pending 为 `""` 且用户按 `/` 时，command bar 必须打开，`pending` 保持 `""`，并且不得立即输出 prompt。

### Requirement: Command-Bar Editable Text Is Local-First / Command-Bar 可编辑文本本地优先

While the command bar is open, printable characters SHALL update command suggestions deterministically and SHALL NOT leak into `pending` prompt output unless explicitly converted by local command bridge output.

命令栏打开时，可打印字符必须本地、确定性地更新可见建议，且不得泄漏到 `pending` prompt 文本，除非被 local command bridge output 明确转换。

#### Scenario: Real-time filtering while command-bar is open / Command-Bar 打开时实时过滤
- **WHEN** the command bar is open and the user types `h`
- **THEN** `commandBar.query` becomes `"h"` and filtered suggestions update without model output
- **中文** 当 command bar 已打开且用户输入 `h` 时，`commandBar.query` 必须变为 `"h"`，filtered suggestions 必须更新，且不得产生 model output。

### Requirement: Unmatched Command-Bar Enter Remains Local / 无匹配 Command-Bar Enter 保持本地

Pressing Enter with a non-empty command query that has no actionable command suggestion SHALL NOT submit raw model input and SHALL keep command-bar context intact.

当 command query 非空但没有可执行 command suggestion 时，按 Enter 不得提交 raw model input，且必须保持 command-bar context。

#### Scenario: Enter does not submit empty suggestions / Enter 不提交空建议
- **WHEN** the command bar is open with query `"zzz"` and no suggestions match, and Enter is pressed
- **THEN** no raw prompt is yielded and command-bar state remains local
- **中文** 当 command bar 以 query `"zzz"` 打开且没有匹配建议，并按下 Enter 时，不得产出 raw prompt，command-bar state 必须保持本地。

### Requirement: Tab Semantics Respect Active Panel / Tab 语义尊重当前面板

When command-bar is open, Tab and Shift+Tab SHALL navigate suggestions. When command-bar is not open, Tab and Shift+Tab SHALL cycle focus panels without switching model pages.

command-bar 打开时，Tab 与 Shift+Tab 必须导航 suggestions。command-bar 未打开时，Tab 与 Shift+Tab 必须切换 focus panels，且不得切换 model pages。

#### Scenario: Tab behavior in command-bar versus panel-mode / Command-Bar 与 Panel 模式下的 Tab 行为
- **WHEN** command-bar is open and suggestions exist, and Tab is pressed
- **THEN** the active suggestion changes
- **WHEN** command-bar is not open and Tab is pressed
- **THEN** focus cycles to another non-command-bar panel, such as `reasoning`
- **中文** 当 command-bar 打开且存在 suggestions 时按 Tab，active suggestion 必须改变；当 command-bar 未打开时按 Tab，focus 必须切换到另一个非 command-bar panel，例如 `reasoning`。

### Requirement: Command Preview Rendering Is Bounded And Sectioned / Command Preview 渲染有界且分区明确

Interactive text-rendered workbench summaries in compact or line mode SHALL be bounded and SHALL include explicit section labels for easy panel boundary recognition.

compact 或 line mode 中交互式文本 workbench summaries 必须有界，并且必须包含明确 section labels，便于识别 panel boundary。

#### Scenario: Compact summary keeps section boundaries explicit / Compact Summary 保持分区边界明确
- **WHEN** the workbench renders a compact or line-mode command summary
- **THEN** the output is bounded and includes explicit section labels
- **中文** 当 workbench 渲染 compact 或 line-mode command summary 时，输出必须有界，并包含明确的 section labels。

### Requirement: Exit Remains Visible And Raw Ctrl+C Exits / Exit 保持可见且 Raw Ctrl+C 退出

The first interactive TUI screen SHALL show a clear input anchor and exit affordance. In raw TUI prompt mode, Ctrl+C SHALL produce an explicit local `/exit` command so the chat loop can terminate even when terminal raw mode consumes the usual process signal.

首个 interactive TUI screen 必须展示清晰 input anchor 与 exit affordance。在 raw TUI prompt mode 中，Ctrl+C 必须产生明确的本地 `/exit` command，使 chat loop 即使在 terminal raw mode 吞掉常规 process signal 时也能退出。

#### Scenario: Ctrl+C exits raw TUI prompt mode / Ctrl+C 退出 Raw TUI Prompt Mode
- **WHEN** raw TUI prompt mode is waiting for input and the user presses Ctrl+C
- **THEN** the prompt reader emits `/exit` as a local command
- **AND** the first screen advertises `Ctrl+C exit` and `/exit`
- **中文** 当 raw TUI prompt mode 等待输入且用户按 Ctrl+C 时，prompt reader 必须将 `/exit` 作为本地 command 发出，且首屏必须展示 `Ctrl+C exit` 与 `/exit`。

### Requirement: Raw Input Has Visible Live Feedback / Raw Input 具备可见实时反馈

Raw TUI prompt input SHALL repaint the visible input anchor after printable input, Backspace, slash command entry, and command-bar query updates. Users SHALL be able to see where text is being entered without waiting for Enter. Command-bar suggestions SHALL render in a stable reserved line above the input anchor, not appended after the input text. The input line and input box SHALL contain only the current input text; no hints or help text may appear after or below the input anchor.

raw TUI prompt input 必须在 printable input、Backspace、slash command entry 与 command-bar query updates 后重绘可见 input anchor。用户必须能在不等待 Enter 的情况下看到文本输入位置。command-bar suggestions 必须渲染在 input anchor 上方的稳定预留行中，不得追加到 input text 后。input line 与 input box 必须只包含当前 input text；不得在 input anchor 后方或下方出现 hints 或 help text。

#### Scenario: Raw prompt text is echoed while typing / Raw Prompt 文本输入时回显
- **WHEN** raw TUI prompt mode is waiting for input and the user types `h`, `i`, Backspace, and `!`
- **THEN** the screen shows `deepseek> h_`, `deepseek> hi_`, and `deepseek> h!_` before Enter
- **中文** 当 raw TUI prompt mode 等待输入且用户输入 `h`、`i`、Backspace 与 `!` 时，屏幕必须在 Enter 前显示 `deepseek> h_`、`deepseek> hi_` 与 `deepseek> h!_`。

#### Scenario: Command-bar query is echoed while filtering / Command-Bar Query 过滤时回显
- **WHEN** raw TUI prompt mode is waiting for input and the user types `/` and `h`
- **THEN** the screen shows `deepseek> /_` and `deepseek> /h_`
- **AND** matching suggestions such as `/help` are visible above the input line
- **中文** 当 raw TUI prompt mode 等待输入且用户输入 `/` 与 `h` 时，屏幕必须显示 `deepseek> /_` 与 `deepseek> /h_`，且 `/help` 等匹配建议必须显示在 input line 上方。

### Requirement: Long Mixed-Language Input Keeps Cursor-Visible Tail / 超长混合语言输入保持光标附近尾部可见

Raw TUI prompt rendering SHALL keep long input bounded by the available input area. When input contains more display cells than fit, visible text SHALL prefer the tail nearest the cursor and preserve mixed Chinese, English, and punctuation characters without appending hints below the input anchor.

raw TUI prompt rendering 必须把超长输入限制在可用 input area 内。当 input 包含超过可显示宽度的 display cells 时，可见文本必须优先展示靠近 cursor 的尾部，并保留中英文与标点符号，不得在 input anchor 下方追加 hints。

#### Scenario: Long mixed-language prompt keeps the tail visible / 超长混合语言 Prompt 保持尾部可见
- **WHEN** raw TUI prompt mode is waiting for input and the user types long Chinese, English, and punctuation text that exceeds the input width
- **THEN** the input anchor shows a bounded tail ending at the cursor
- **AND** the visible tail includes the final mixed-language characters and symbols
- **中文** 当 raw TUI prompt mode 等待输入且用户输入超过 input width 的中英混合与标点文本时，input anchor 必须显示以 cursor 结尾的有界尾部，并包含最终混合语言字符与符号。

### Requirement: Log-Shaped Input Is Display-Safe / 日志形状输入显示安全

Raw TUI prompt rendering SHALL sanitize pasted or buffered log-shaped text before drawing it into the input anchor. Raw newlines, carriage returns, tabs, ANSI escape bytes, and control bytes SHALL NOT move the cursor, recolor the terminal, create extra input-area rows, or obscure the current input anchor.

raw TUI prompt rendering 必须先清理 pasted 或 buffered log-shaped text，然后再绘制进 input anchor。raw newlines、carriage returns、tabs、ANSI escape bytes 与 control bytes 不得移动 cursor、改变 terminal color、创建额外 input-area rows 或遮挡当前 input anchor。

#### Scenario: Hundreds of log lines stay inside one input anchor / 大量日志行保持在单个 Input Anchor 中
- **WHEN** raw TUI prompt rendering receives hundreds of log-like lines with paths, ANSI escapes, JSON fragments, Chinese text, emoji, tabs, and symbols
- **THEN** the visible input anchor remains a single bounded display line
- **AND** raw control characters are escaped as visible text instead of being emitted to the terminal
- **中文** 当 raw TUI prompt rendering 收到包含 paths、ANSI escapes、JSON fragments、中文文本、emoji、tabs 与符号的大量 log-like lines 时，可见 input anchor 必须保持为单个有界 display line，且 raw control characters 必须转义成可见文本而不是直接输出到 terminal。

### Requirement: Bracketed Paste Keeps Multiline Text In One Prompt / Bracketed Paste 将多行文本保持在单个 Prompt 中

When raw input receives bracketed paste start and end events, newline characters inside the paste SHALL be appended to the prompt buffer instead of submitting intermediate prompts. Slash-prefixed pasted text SHALL remain literal prompt text and SHALL NOT open the command bar. Full-screen TUI entry SHALL enable terminal bracketed paste mode and teardown SHALL disable it.

当 raw input 收到 bracketed paste start 与 end events 时，paste 内部的 newline characters 必须追加到 prompt buffer，而不是提交中间 prompts。以 slash 开头的 pasted text 必须保持为 literal prompt text，且不得打开 command bar。Full-screen TUI entry 必须启用 terminal bracketed paste mode，teardown 必须关闭它。

#### Scenario: Bracketed multiline paste submits as one prompt / Bracketed 多行 Paste 作为一个 Prompt 提交
- **WHEN** raw TUI prompt mode is waiting for input and the terminal sends bracketed paste containing `/first`, newlines, and log text
- **THEN** no command bar opens during the paste
- **AND** pressing Enter after paste end submits the whole pasted text as one prompt
- **中文** 当 raw TUI prompt mode 等待输入且 terminal 发送包含 `/first`、newlines 与 log text 的 bracketed paste 时，paste 期间不得打开 command bar，且 paste end 后按 Enter 必须把整个 pasted text 作为一个 prompt 提交。

### Requirement: Full-Screen TUI Uses Coherent Full-Frame Repaint / Full-Screen TUI 使用连贯的完整 Frame 重绘

When chat runs with `--tui full-screen`, raw prompt updates SHALL repaint the full-screen frame instead of writing line-mode prompt fragments. The full-screen first screen SHALL keep internals low density, show a stable input box, and render command suggestions above the input box.

当 chat 使用 `--tui full-screen` 运行时，raw prompt updates 必须重绘 full-screen frame，而不是写入 line-mode prompt fragments。full-screen 首屏必须保持低密度 internals，展示稳定 input box，并将 command suggestions 渲染在 input box 上方。

#### Scenario: Full-screen command filtering repaints the frame / Full-Screen Command 过滤重绘 Frame
- **WHEN** chat is running with `--tui full-screen` and the user types `/` and `h`
- **THEN** the repaint output contains a `Suggestions` region above an `Input` region
- **AND** the input region shows `deepseek> /h_`
- **AND** line-mode prompt fragments are not written into the full-screen frame
- **中文** 当 chat 使用 `--tui full-screen` 运行且用户输入 `/` 与 `h` 时，repaint output 必须包含位于 `Input` region 上方的 `Suggestions` region，input region 必须显示 `deepseek> /h_`，且不得把 line-mode prompt fragments 写入 full-screen frame。

#### Scenario: Full-screen prompt text is echoed while typing / Full-Screen Prompt 文本输入时回显
- **WHEN** chat is running with `--tui full-screen` and the user types `h` and `i` before pressing Enter
- **THEN** the full-screen input box shows `deepseek> h_` and `deepseek> hi_`
- **AND** the input box is repainted through the same full-screen frame path
- **中文** 当 chat 使用 `--tui full-screen` 运行且用户在 Enter 前输入 `h` 与 `i` 时，full-screen input box 必须显示 `deepseek> h_` 与 `deepseek> hi_`，且 input box 必须通过相同 full-screen frame path 重绘。

### Requirement: Full-Screen Raw Repaint Avoids Per-Key Clear-Screen Flicker / Full-Screen Raw Repaint 避免每键清屏闪烁

When chat runs with `--tui full-screen`, the renderer MAY clear the alternate screen on entry, but raw prompt repaint updates SHALL NOT clear the screen on every key press. Repaints SHALL return to the frame origin and overwrite a padded full frame so large input does not visually flash or jump.

当 chat 使用 `--tui full-screen` 运行时，renderer 可以在进入 alternate screen 时清屏，但 raw prompt repaint updates 不得在每次按键时清屏。Repaints 必须回到 frame origin 并覆盖带 padding 的完整 frame，避免大输入产生视觉闪烁或跳动。

#### Scenario: Full-screen raw typing does not clear the screen per key / Full-Screen Raw 输入不逐键清屏
- **WHEN** chat is running with `--tui full-screen` and the user types multiple prompt characters before submitting
- **THEN** the alternate screen is cleared only when entering the full-screen view
- **AND** each prompt repaint moves to the frame origin without emitting another clear-screen sequence
- **中文** 当 chat 使用 `--tui full-screen` 运行且用户在提交前输入多个 prompt characters 时，alternate screen 只能在进入 full-screen view 时清屏，且每次 prompt repaint 必须移动到 frame origin，不得再次发出 clear-screen sequence。
