import type { JsonObject, SessionId, SessionStore } from "@deepseek/platform-contracts";

export async function inputWithSessionWorkspaceRoot(
  sessions: Pick<SessionStore, "metadata">,
  input: JsonObject,
  sessionId: SessionId
): Promise<JsonObject> {
  if (typeof input.workspaceRoot === "string") return input;
  const metadata = await sessions.metadata(sessionId);
  const workspaceRoot = metadata.ok && metadata.value ? metadata.value.metadata.workspaceRoot : undefined;
  return typeof workspaceRoot === "string" && workspaceRoot
    ? { ...input, workspaceRoot }
    : input;
}
