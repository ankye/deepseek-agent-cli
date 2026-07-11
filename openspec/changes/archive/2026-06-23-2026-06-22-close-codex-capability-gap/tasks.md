# Tasks

## OpenSpec / 规格

- [x] Create this OpenSpec change for Codex-class capability gap closure.
- [x] Record the source boundary: official Codex documentation was unavailable in this session, so comparison claims are bounded to Codex-class observed capability surfaces.
- [x] Define the gap dimensions and closure strategy.
- [x] Define production tool tiers.
- [x] Define capability/affordance compiler acceptance rules.
- [x] Validate this change with `npx openspec validate 2026-06-22-close-codex-capability-gap --strict`.
- [x] Validate canonical specs with `npx openspec validate --specs --strict`.

- [x] 创建 Codex-class capability gap closure OpenSpec change。
- [x] 记录来源边界：本会话无法获取官方 Codex 文档，因此对比声明限定为 Codex-class 可观察能力面。
- [x] 定义差距维度与闭环策略。
- [x] 定义生产工具层级。
- [x] 定义 capability/affordance compiler 验收规则。
- [x] 使用 `npx openspec validate 2026-06-22-close-codex-capability-gap --strict` 校验本 change。
- [x] 使用 `npx openspec validate --specs --strict` 校验 canonical specs。

## Registry And Projection / 注册表与投影

- [x] Add a first-class capability/affordance compiler that resolves profile family requirements into model-visible executable tools.
- [x] Make every engineering profile declare required families instead of raw ad hoc tool lists.
- [x] Fail before model dispatch when required families are absent, unregistered, or hidden.
- [x] Distinguish absent implementation, disabled-by-policy, blocked-by-sandbox, credential-missing, and projection-bug diagnostics.
- [x] Emit prompt assembly evidence that includes required family ids, resolved tool ids, hidden tool ids, and projection status.

- [x] 增加 first-class capability/affordance compiler，将 profile family requirements 解析为 model-visible executable tools。
- [x] 让每个 engineering profile 声明 required families，而不是 raw ad hoc tool lists。
- [x] required families 缺失、未注册或被隐藏时，在 model dispatch 前失败。
- [x] 区分 absent implementation、disabled-by-policy、blocked-by-sandbox、credential-missing 与 projection-bug diagnostics。
- [x] 输出 prompt assembly evidence，包含 required family ids、resolved tool ids、hidden tool ids 与 projection status。

## Tool Surface / 工具面

- [x] Implement or expose Tier 1 coding closure families: `core.file.write`, `core.file.edit`, `core.patch.apply`, `core.shell.run`, `core.test.run`, `core.git.status`, and `core.git.diff`.
- [x] Ensure tool executors return typed evidence suitable for downstream stage gates.
- [x] Add read/write risk classes and policy hooks for each mutating tool.
- [x] Add bounded tool feedback previews for shell, test, patch, and file edit results.
- [x] Keep Tier 2 and Tier 3 tools explicit and opt-in by host policy; do not expose all tools by default.

- [x] 实现或暴露 Tier 1 coding closure families：`core.file.write`、`core.file.edit`、`core.patch.apply`、`core.shell.run`、`core.test.run`、`core.git.status` 与 `core.git.diff`。
- [x] 确保 tool executors 返回适合下游 stage gates 的 typed evidence。
- [x] 为每个 mutation tool 增加 read/write risk classes 与 policy hooks。
- [x] 为 shell、test、patch 与 file edit 结果增加 bounded tool feedback previews。
- [x] Tier 2 与 Tier 3 tools 继续由 host policy 显式 opt-in；不得默认暴露全部工具。

## Isolation And Credentials / 隔离与凭据

- [x] Add provider credential resolution that works from disposable workspaces through user/global configuration while preserving redaction.
- [x] Record credential presence, source class, and redaction metadata without raw secret values.
- [x] Classify missing disposable-workspace credentials as `invalid-test-environment` only when user/global credentials are truly unavailable.
- [x] Add regression tests for isolated workspace credential fallback.

- [x] 增加 provider credential resolution，使 disposable workspaces 可通过 user/global configuration 工作并保持脱敏。
- [x] 记录 credential presence、source class 与 redaction metadata，不记录 raw secret values。
- [x] 仅当 user/global credentials 确实不可用时，才把 disposable-workspace credential 缺失归为 `invalid-test-environment`。
- [x] 为 isolated workspace credential fallback 增加回归测试。

## Evaluation And Comparison / 评估与对比

- [x] Extend capability-matrix classification to mark absent or unprojected required general tools as `blocked-by-cli-capability-gap`.
- [x] Add Codex-class gap scorecard output with tool-surface, projection, closure, isolation, and recovery dimensions.
- [x] Mark external Codex baseline evidence as `unavailable` unless an explicit opt-in baseline run or official-source refresh exists.
- [x] Gate pass outcomes on diffs, tests, artifacts, stage evidence, and terminal events rather than final text.
- [x] Add per-task structured guidance so capability-matrix output gives owner layer, root cause, next repair action, rerun condition, evidence gaps, and confidence.
- [x] Add a session execution board view so each persisted session can be inspected as ordered steps instead of raw event logs only.
- [x] Resolve relative capability-matrix CLI entrypoint paths from the launch workspace before executing disposable-workspace tasks.
- [x] Discover the CLI workspace root from nested launch directories using project markers while preserving explicit injected roots.
- [x] Rerun T01 through T08 live after Tier 1 projection and credential fallback are fixed; evidence: `.deepseek/capability-matrix/live-20260622-glm51-dist`.
- [x] Investigate live T08 model-iteration-limit / blocked-by-cli-bug result and identify malformed model tool input crossing the tool executor boundary.
- [x] Contain malformed `core.file.write` input as typed tool failure instead of allowing a CLI process crash.
- [x] Add ready-stage non-progress tool-call guard so repeated allowed-but-non-progress tools fail closed as `workflow-required-action-missed` instead of exhausting model iterations.
- [x] Rerun T08 after workspace discovery, input guard, and stage mismatch guard; evidence: `.deepseek/capability-matrix/live-20260622-glm51-t08-after-progress-satisfied`, final classification `blocked-by-model`.
- [x] Remove the misleading engineering workflow `test` mutation stage and align the ready-stage prompt with required progress actions (`progress`/`required`).
- [x] Add regression coverage proving engineering workflow mutation stages are named and projected as implementation stages, not test-only stages.
- [x] Add regression coverage proving ready produce stages expose mutation progress and exact required capability choices in the prompt state section.
- [x] Fix secret-sandbox false positives for human-readable DeepSeek report-directory slugs so live validation workspaces are not denied as raw API keys.
- [x] Preserve user path literal casing in task-delivery normalized intents so profile/prompt projection cannot rewrite requested artifact paths.
- [x] Add generic artifact-path contract checks so capability-matrix artifact delivery distinguishes exact requested paths from case-mismatched generated files.
- [x] Project requested file path literals into the generic file mutation output contract so models see exact case-sensitive targets before writing.
- [x] Make the file mutation output contract trigger for Chinese generation prompts and chat-mode staged engineering runs, not only explicit coding mode.
- [x] Make the file mutation output contract stage-aware so produce/repair stages do not keep telling the model to inspect after evidence collection is already complete.
- [x] Narrow provider-visible tools for active produce/repair ready stages to mutation progress capabilities so supporting read/search tools do not compete with required write/edit/patch actions.
- [x] Reject hallucinated or stale non-visible supporting tools before execution during produce/materialize/repair stages, and correct with exact provider function names.
- [x] Expand ready-stage required-action correction attempts to a bounded budget and record attempt counts before fail-closed classification.
- [x] Enforce requested artifact path literals case-sensitively inside runtime output verification on every platform, and route failures back into bounded repair before staged workflows close.
- [x] Reject case-mismatched file mutation tool calls before execution while an artifact output-contract repair gate is active, returning the exact requested path literal as tool feedback.
- [x] Treat `agent.loop.failed` and `agent.loop.cancelled` as terminal capability-matrix evidence, and classify by the final terminal failure reason rather than earlier transient workflow corrections.

- [x] 扩展 capability-matrix classification，将缺失或未投影的必需通用工具标记为 `blocked-by-cli-capability-gap`。
- [x] 增加 Codex-class gap scorecard 输出，覆盖 tool-surface、projection、closure、isolation 与 recovery 维度。
- [x] 除非存在显式 opt-in baseline run 或官方来源刷新，否则 external Codex baseline evidence 标记为 `unavailable`。
- [x] pass outcome 必须由 diff、test、artifact、stage evidence 与 terminal event 决定，而不是 final text。
- [x] 为每个 task 增加 structured guidance，使 capability-matrix output 给出 owner layer、root cause、下一步修复动作、rerun condition、evidence gaps 与 confidence。
- [x] 增加 session execution board view，使每个已持久化 session 可以按有序步骤查看，而不只能读取 raw event logs。
- [x] 从 launch workspace 解析 capability-matrix 的相对 CLI entrypoint，再进入 disposable workspace 执行任务。
- [x] 从嵌套启动目录自动发现 CLI workspace root，同时保留显式注入 root 的最高优先级。
- [x] 修复 Tier 1 projection 与 credential fallback 后，重新 live 运行 T01 到 T08；证据：`.deepseek/capability-matrix/live-20260622-glm51-dist`。
- [x] 分析 live T08 的 model-iteration-limit / blocked-by-cli-bug 结果，定位为畸形模型工具参数穿透了 tool executor 边界。
- [x] 将畸形 `core.file.write` 输入收敛为 typed tool failure，避免 CLI 进程崩溃。
- [x] 增加 ready-stage non-progress tool-call guard，使重复调用允许但不推进阶段的工具时以 `workflow-required-action-missed` fail closed，而不是耗尽模型迭代。
- [x] 在 workspace discovery、input guard 与 stage mismatch guard 后重跑 T08；证据：`.deepseek/capability-matrix/live-20260622-glm51-t08-after-progress-satisfied`，最终分类 `blocked-by-model`。
- [x] 移除误导性的 engineering workflow `test` mutation stage，并将 ready-stage prompt 与 required progress action 对齐（`progress`/`required`）。
- [x] 增加回归覆盖，证明 engineering workflow 的 mutation stages 被命名与投影为 implementation stages，而不是 test-only stages。
- [x] 增加回归覆盖，证明 ready produce stages 在 prompt state section 中暴露 mutation progress 与精确 required capability choices。
- [x] 修复 secret-sandbox 对 human-readable DeepSeek report-directory slug 的误报，避免 live validation workspace 被当成 raw API key 拒绝。
- [x] 在 task-delivery normalized intents 中保留用户路径字面量大小写，避免 profile/prompt projection 改写请求的 artifact paths。
- [x] 增加通用 artifact-path contract 检查，使 capability-matrix artifact delivery 可以区分精确请求路径与大小写不匹配的生成文件。
- [x] 将请求中的文件路径字面量投影到通用 file mutation output contract，使模型写入前能看到大小写敏感的精确目标。
- [x] 让 file mutation output contract 对中文“生成”类 prompt 与 chat-mode staged engineering run 生效，而不是只在显式 coding mode 生效。
- [x] 让 file mutation output contract 感知阶段状态，避免 evidence collection 已完成后仍在 produce/repair 阶段提示模型继续 inspect。
- [x] 将 active produce/repair ready stage 的 provider-visible tools 收窄到 mutation progress capabilities，避免 supporting read/search tools 与必需 write/edit/patch action 竞争。
- [x] 在 produce/materialize/repair 阶段，对模型幻觉或旧上下文造成的非当前可见 supporting tool 调用执行前拒绝，并用精确 provider function names 进行纠正。
- [x] 将 ready-stage required-action 纠正次数扩展为 bounded budget，并在 fail-closed 分类前记录 attempt counts。
- [x] 在 runtime output verification 中跨平台按大小写敏感方式验收请求的 artifact path literals，并在 staged workflow 关闭前把失败导回 bounded repair。
- [x] 当 artifact output-contract repair gate 激活时，在执行前拒绝大小写不匹配的 file mutation tool call，并在 tool feedback 中返回精确请求路径字面量。
- [x] 将 `agent.loop.failed` 与 `agent.loop.cancelled` 视为 capability-matrix 的 terminal evidence，并按最终 terminal failure reason 分类，而不是被早期临时 workflow correction 误导。
