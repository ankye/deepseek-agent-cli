import type {
  RuntimeDependencies,
  RuntimeKernelDependencies
} from "@deepseek/platform-contracts";
import { kernelError } from "./errors.js";

export function assertRuntimeKernelDependencies(deps: RuntimeKernelDependencies): void {
  const missing = [
    "bus",
    "workflow",
    "scheduler",
    "capabilities",
    "policy",
    "approvals",
    "sandbox",
    "sessions",
    "observability",
    "platform",
    "clock",
    "ids",
    "logger"
  ].filter((key) => (deps as unknown as Record<string, unknown>)[key] === undefined);
  if (missing.length > 0) {
    throw new Error(kernelError("KERNEL_CONFIGURATION_ERROR", `Missing runtime kernel dependencies: ${missing.join(", ")}`).message);
  }
}

export function runtimeKernelDependencies(
  deps: RuntimeDependencies,
  options: Pick<RuntimeKernelDependencies, "clock" | "ids" | "logger">
): RuntimeKernelDependencies {
  return {
    bus: deps.bus,
    workflow: deps.workflow,
    scheduler: deps.concurrency,
    capabilities: deps.capabilities,
    policy: deps.policy,
    approvals: deps.approvals,
    sandbox: deps.sandbox,
    sessions: deps.sessions,
    observability: deps.observability,
    platform: deps.platform,
    clock: options.clock,
    ids: options.ids,
    logger: options.logger
  };
}
