import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_SCHEMA_VERSION, asId } from "@deepseek/platform-contracts";
import type {
  ApprovalBroker,
  ApprovalDecision,
  ApprovalId,
  ApprovalRequest,
  JsonObject,
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
  PolicyDecision,
  PolicyEngine,
  PolicyRequest
} from "@deepseek/platform-contracts";
import { createDefaultRuntimeKernel, registerRuntimeCoreTools } from "@deepseek/runtime";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";
import { parseCliArgs, runCli } from "../src/index.js";

describe("CLI approval mode", () => {
  it("parses trusted approval mode without leaking flags into the prompt", () => {
    assert.deepEqual(parseCliArgs(["run", "long task", "--approval-mode", "trusted", "--output", "jsonl"]), {
      command: "run",
      prompt: "long task",
      output: "jsonl",
      live: false,
      approvalMode: "trusted"
    });
    assert.deepEqual(parseCliArgs(["chat", "--trusted", "--output", "jsonl"]), {
      command: "chat",
      prompt: "",
      output: "jsonl",
      live: false,
      approvalMode: "trusted"
    });
  });

  it("propagates trusted approval mode so ask decisions can be auto-approved", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const approvalDeps = { ...deps, models: new ToolCallingModelGateway(), policy: new AskApprovalPolicyEngine() };
    await registerRuntimeCoreTools(approvalDeps, process.cwd());
    await approvalDeps.platform.writeFile(`${process.cwd().replace(/\\/g, "/")}/README.md`, "fixture readme\n");
    const lines: string[] = [];
    await runCli(
      ["run", "read README", "--output", "jsonl", "--approval-mode", "trusted"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async (options) => {
          const trustedDeps = options.approvalMode === "trusted"
            ? { ...approvalDeps, approvals: new TrustedApprovalBroker() }
            : approvalDeps;
          return { deps: trustedDeps, kernel: await createDefaultRuntimeKernel(trustedDeps) };
        }
      }
    );
    const events = lines.map((line) => JSON.parse(line) as { kind: string; data?: { approval?: { decision?: { decision?: string; source?: string } }; capabilityId?: string } });

    assert.equal(events.some((event) => event.kind === "approval.denied"), false);
    assert.equal(events.some((event) => event.kind === "approval.decided" && event.data?.approval?.decision?.decision === "allow"), true);
    assert.equal(events.some((event) => event.kind === "capability.completed" && event.data?.capabilityId === "core.file.read"), true);
  });

  it("passes trusted approval mode through chat runtime creation", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const runtimeOptions: string[] = [];
    const runtimeDeps = { ...deps, models: new FinalModelGateway() };
    await registerRuntimeCoreTools(runtimeDeps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(runtimeDeps);
    await runCli(
      ["chat", "--output", "jsonl", "--trusted"],
      () => {},
      ["hello\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async (options) => {
          runtimeOptions.push(options.approvalMode ?? "unset");
          return { deps: runtimeDeps, kernel };
        }
      }
    );

    assert.deepEqual(runtimeOptions, ["trusted"]);
    await kernel.shutdown("approval-mode-chat-test");
  });
});

class ToolCallingModelGateway implements ModelGateway {
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.messages?.some((message) => message.role === "tool")) {
      yield { kind: "delta", text: "Read completed." };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "tool-call", id: "call-readme", name: "core.file.read", input: { path: "./README.md" } };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class FinalModelGateway implements ModelGateway {
  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { kind: "delta", text: "done" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class AskApprovalPolicyEngine implements PolicyEngine {
  async decide(request: PolicyRequest): Promise<PolicyDecision> {
    const trace = request.auditEvidence?.trace ?? {
      traceId: asId<"trace">("trace-cli-approval"),
      spanId: asId<"span">("span-cli-approval"),
      correlationId: asId<"correlation">("corr-cli-approval")
    };
    const approval: ApprovalRequest = {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      approvalId: "approval:cli-test" as ApprovalId,
      subject: request.subject,
      action: request.action,
      resource: request.resource,
      metadata: request.metadata,
      prompt: "Approve CLI tool execution?",
      decisionOptions: ["allow", "deny", "cancel"],
      summary: {
        schemaVersion: APPROVAL_SCHEMA_VERSION,
        title: "Approval required",
        subject: request.subject,
        action: request.action,
        resource: request.resource,
        capability: request.resource,
        targetKind: "capability",
        targetLabel: request.resource,
        riskSummaries: [],
        allowedDecisions: ["allow", "deny", "cancel"],
        referencePitFixtureIds: ["pit.headless-trust.fail-closed"],
        redaction: { class: "internal", fields: ["targetLabel"] },
        metadata: {}
      },
      auditReference: {
        schemaVersion: APPROVAL_SCHEMA_VERSION,
        traceId: trace.traceId,
        correlationId: trace.correlationId,
        policyDecision: "ask",
        reasonCodes: ["policy.approval.required"],
        redaction: { class: "internal", fields: ["reasonCodes"] }
      },
      trace,
      compatibility: { schemaVersion: APPROVAL_SCHEMA_VERSION }
    };
    return {
      action: "ask",
      reason: "Approval required by CLI test policy",
      audit: { policy: "cli-ask-test" },
      sandboxProfile: "development",
      approvalRequest: approval,
      approvalSummary: approval.summary,
      approval: {
        schemaVersion: APPROVAL_SCHEMA_VERSION,
        kind: "approval.required",
        approvalId: approval.approvalId,
        trace,
        summary: approval.summary,
        auditReference: approval.auditReference,
        redaction: { class: "internal" },
        compatibility: { schemaVersion: APPROVAL_SCHEMA_VERSION }
      }
    };
  }
}

class TrustedApprovalBroker implements ApprovalBroker {
  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    return {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      approvalId: request.approvalId,
      approved: true,
      decision: "allow",
      source: "automation",
      reason: "Approved by trusted CLI approval mode.",
      reasonCode: "cli.trusted.approval.allow",
      auditReference: request.auditReference,
      trace: request.trace,
      redaction: { class: "internal", fields: ["reason"] },
      metadata: {
        approvalMode: "trusted",
        summary: request.summary
      } as JsonObject
    };
  }
}
