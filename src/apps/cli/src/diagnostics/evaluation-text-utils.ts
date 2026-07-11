export function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
}

export function correctionSignalCount(value: string): number {
  const normalized = value.toLowerCase();
  const matches = normalized.match(/\b(retry|retried|again|fix|fixed|correct|corrected|repair|repaired|failed|error)\b/g);
  return Math.min(matches?.length ?? 0, 20);
}

export function redactPromptArg(value: string): string {
  return value.includes("\n") || value.length > 80 ? "[PROMPT]" : value;
}

export function boundedPreview(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n");
  return normalized.length <= 1200 ? normalized : `${normalized.slice(0, 1200)}...[truncated]`;
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
