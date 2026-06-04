## 1. Credential Fallback / 凭证回退

- [x] 1.1 Add a failing regression test proving GLM credential loading can fall back from an isolated task cwd to the original launch cwd `.env`. / 增加失败回归测试，证明 GLM credential loading 可从隔离 task cwd 回退到原始 launch cwd `.env`。
- [x] 1.2 Implement launch cwd fallback without changing provider adapters or exposing raw secrets. / 实现 launch cwd fallback，且不修改 provider adapters、不暴露 raw secrets。
- [x] 1.3 Validate OpenSpec, run focused tests, and run a CLI-entrypoint GLM fallback probe that reaches the provider layer instead of failing with `PROVIDER_CREDENTIAL_MISSING`. / 校验 OpenSpec、运行聚焦测试，并通过 CLI 入口运行 GLM fallback probe，确认它进入 provider layer，而不是因 `PROVIDER_CREDENTIAL_MISSING` 失败。
