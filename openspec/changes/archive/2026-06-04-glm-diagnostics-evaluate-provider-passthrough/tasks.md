## 1. Provider Passthrough / Provider 透传

- [x] 1.1 Add a failing CLI evaluation test proving `modelProvider=glm` and `model=glm-5.1` reach the isolated `deepseek run` command. / 增加失败的 CLI evaluation test，证明 `modelProvider=glm` 与 `model=glm-5.1` 会到达隔离的 `deepseek run` 命令。
- [x] 1.2 Forward provider/model options and GLM live credential env to the evaluation subprocess without exposing raw secrets. / 将 provider/model options 与 GLM live credential env 透传到 evaluation 子进程，且不暴露 raw secrets。
- [x] 1.3 Validate OpenSpec and run the focused CLI test before using GLM score output. / 在使用 GLM 跑分输出前校验 OpenSpec 并运行聚焦 CLI test。
