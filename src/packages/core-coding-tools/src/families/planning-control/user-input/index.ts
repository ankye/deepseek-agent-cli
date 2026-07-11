import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps } from "../../../shared/workspace.js";

export interface CoreUserInputRequest extends JsonObject {
  readonly prompt: string;
  readonly inputType: "text" | "confirm" | "choice";
  readonly choices: readonly string[];
  readonly required: boolean;
}

export interface CoreUserInputDecision extends JsonObject {
  readonly status: "answered" | "cancelled" | "timeout";
  readonly value?: string | boolean;
  readonly source: "interactive-host" | "scripted" | "test";
  readonly reason?: string;
}

export interface UserInputToolDeps extends CoreCodingToolsDependencies {
  readonly userInput?: {
    requestInput(request: CoreUserInputRequest): Promise<CoreUserInputDecision>;
  };
}

export function defineUserInputTool(deps: UserInputToolDeps | undefined) {
  return defineToolManifest(
    "user.input",
    coreToolIds.userInput,
    "User Input",
    "none",
    ["host:user-input"],
    objectSchema(["prompt"], {
      prompt: { type: "string" },
      inputType: { type: "string", enum: ["text", "confirm", "choice"] },
      choices: { type: "array", items: { type: "string" } },
      required: { type: "boolean" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => userInputTool(input, context, ready as UserInputToolDeps))
  );
}

async function userInputTool(input: JsonObject, context: CapabilityExecutionContext, deps: UserInputToolDeps): Promise<SerializableResult<CoreToolResult>> {
  const prompt = stringValue(input.prompt);
  if (!prompt) return failure("user.input", "USER_INPUT_PROMPT_REQUIRED", "prompt is required.", []);
  const request: CoreUserInputRequest = {
    prompt: boundedText(prompt, 2_000).text,
    inputType: input.inputType === "confirm" || input.inputType === "choice" ? input.inputType : "text",
    choices: stringArray(input.choices).slice(0, 20),
    required: input.required !== false
  };
  if (!deps.userInput) {
    return failure("user.input", "USER_INPUT_HEADLESS_UNAVAILABLE", "Interactive user input is unavailable in headless runtime.", [], {
      status: "cancelled",
      source: "headless-default",
      promptBytes: request.prompt.length,
      replay: replay(context)
    });
  }
  const decision = await deps.userInput.requestInput(request);
  if (decision.status !== "answered") {
    return failure("user.input", `USER_INPUT_${decision.status.toUpperCase()}`, decision.reason ?? `User input ${decision.status}.`, [], {
      status: decision.status,
      source: decision.source
    });
  }
  const value = typeof decision.value === "string" ? boundedText(decision.value, 8_000).text : decision.value;
  return success("user.input", [], {
    metadata: {
      status: "answered",
      value,
      source: decision.source,
      inputType: request.inputType,
      choiceCount: request.choices.length
    },
    replay: replay(context)
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
