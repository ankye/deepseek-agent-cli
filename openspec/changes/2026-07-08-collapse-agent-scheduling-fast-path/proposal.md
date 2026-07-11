# Collapse Agent Scheduling Fast Path

## Why

Recent first-task canaries show that the CLI can still spend many model turns on repeated discovery, rejected verification commands, stale stage feedback, and review loops even when the effective solution path is short. Tactical fixes addressed individual defects, but the architecture still exposes too many competing signals to the child model and leaves more than one component able to imply the next action.

最近的第一题 canary 显示，即使有效解题路径很短，CLI 仍可能在重复 discovery、被拒绝的验证命令、过期 stage feedback 与 review loop 上消耗很多模型轮次。战术修复已经处理了若干单点缺陷，但架构上仍向 child model 暴露了过多相互竞争的信号，并且仍有多个组件可以暗示下一步动作。

The system needs a scheduling fast path that compresses simple coding tasks into one authoritative next action per turn, while keeping recovery, failure attribution, and technical-director review evidence-driven and replayable. This is not a benchmark shortcut and not a five-step hard cap. It is a runtime contract that makes the natural short path possible when the model chooses the correct work.

系统需要一个调度快路径：把简单代码任务压缩为每轮一个权威 next action，同时让 recovery、failure attribution 与 technical-director review 保持证据驱动、可 replay。这不是 benchmark shortcut，也不是五步硬上限，而是 runtime contract：当模型选择正确工作时，自然短路径必须可达。

## What Changes

- Define a scheduling fast path for straightforward patch tasks: focused evidence, mutation, standard verification, package or terminal report.
- 定义直接补丁任务的调度快路径：focused evidence、mutation、standard verification、package 或 terminal report。
- Require exactly one authoritative `nextAction` projection for each ready stage or recovery turn.
- 要求每个 ready stage 或 recovery turn 只投影一个权威 `nextAction`。
- Keep governance, cache, diagnostics, technical-director acceptance, and historical board records out of child model-visible prompt unless they are required for the immediate next action.
- 将 governance、cache、diagnostics、technical-director acceptance 与历史 board records 从 child model-visible prompt 中移出，除非它们是 immediate next action 必需信息。
- Make recovery resume from the board's accepted next action instead of restarting discovery by default.
- 让 recovery 从 board 已接受的 next action 恢复，而不是默认重启 discovery。
- Add quality gates that measure short-path convergence as trajectory evidence without hardcoding benchmark task numbers, expected patches, scorer behavior, or model-specific glue.
- 增加质量 gate，把短路径收敛作为 trajectory evidence 衡量，但不得硬编码 benchmark task number、expected patch、scorer behavior 或模型专用胶水。
- Add an implementation plan that first closes deterministic scheduler contracts, then validates with one canary run.
- 增加实施计划：先关闭确定性调度契约，再用一个 canary run 验证。

## Non-Goals

- Do not encode a five-step limit inside CLI runtime behavior.
- 不在 CLI runtime 行为中编码五步限制。
- Do not hardcode benchmark instance ids, task numbers, known patches, file names, test commands, providers, models, or scorer shortcuts.
- 不硬编码 benchmark instance ids、task numbers、known patches、file names、test commands、providers、models 或 scorer shortcuts。
- Do not replace task/profile contracts. They remain declarative control-plane inputs.
- 不替换 task/profile contracts。它们仍是声明式控制面输入。
- Do not copy reference implementation code or proprietary structure into this project.
- 不把参考实现代码或专有结构复制进本项目。
- Do not add a Java-style class hierarchy. The implementation should stay flat, testable, and close to existing TypeScript module boundaries.
- 不引入 Java 风格 class hierarchy。实现应保持扁平、可测试，并贴近现有 TypeScript module boundary。
