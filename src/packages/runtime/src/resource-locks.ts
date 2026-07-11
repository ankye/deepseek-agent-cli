import type { ResourceLock } from "@deepseek/platform-contracts";
import { posix } from "node:path";

const RESOURCE_LOCK_KIND_SET = new Set<ResourceLock["kind"]>([
  "workspace",
  "path",
  "session",
  "agent-instance",
  "model-provider",
  "process-slot",
  "extension-loading",
  "plugin-install-update",
  "mcp-connection",
  "hook-execution",
  "remote-transport"
]);

export interface ResourceLockNormalizationOptions {
  readonly workspaceRoot?: string;
  readonly caseSensitive?: boolean;
}

export function normalizeResourceLocks(locks: readonly string[], options: string | ResourceLockNormalizationOptions = {}): readonly ResourceLock[] {
  const normalization = typeof options === "string" ? { workspaceRoot: options } : options;
  const entries = new Map<string, ResourceLock>();
  for (const lock of locks) {
    const parsed = parseResourceLock(lock, normalization);
    if (!parsed) continue;
    entries.set(`${parsed.kind}:${parsed.key}`, parsed);
  }
  return [...coalesceResourceLocks([...entries.values()])]
    .sort((left: ResourceLock, right: ResourceLock) => `${left.kind}:${left.key}`.localeCompare(`${right.kind}:${right.key}`));
}

export function normalizeResourceLockStrings(locks: readonly string[], options: string | ResourceLockNormalizationOptions = {}): readonly string[] {
  return normalizeResourceLocks(locks, options).map((lock) => `${lock.kind}:${lock.key}`);
}

export function resourceLockStringsConflict(left: string, right: string): boolean {
  if (left === right) return true;
  const leftSeparator = left.indexOf(":");
  const rightSeparator = right.indexOf(":");
  if (leftSeparator <= 0 || rightSeparator <= 0) return false;
  const leftKind = left.slice(0, leftSeparator);
  const rightKind = right.slice(0, rightSeparator);
  if (!resourceLockKindsConflict(leftKind, rightKind)) return false;
  if (!isHierarchicalLockKind(leftKind) || !isHierarchicalLockKind(rightKind)) return false;
  const leftKey = left.slice(leftSeparator + 1);
  const rightKey = right.slice(rightSeparator + 1);
  return pathKeyContains(leftKey, rightKey) || pathKeyContains(rightKey, leftKey);
}

export function normalizeResourceLockKey(kind: ResourceLock["kind"] | "process", key: string, options: ResourceLockNormalizationOptions = {}): string {
  const normalizedKind = kind === "process" ? "process-slot" : kind;
  if (normalizedKind === "workspace" || normalizedKind === "path" || normalizedKind === "process-slot") {
    return normalizePathLikeLockKey(key, options);
  }
  return key.trim();
}

export function normalizeWorkspaceResourceLockKey(key: string, options: string | ResourceLockNormalizationOptions = {}): string {
  const normalization = typeof options === "string" ? { workspaceRoot: options } : options;
  const normalizedKey = normalizePathLikeLockKey(key, normalization);
  const normalizedRoot = normalization.workspaceRoot ? normalizePathLikeLockKey(normalization.workspaceRoot, normalization) : undefined;
  if (!normalizedRoot || normalizedRoot === ".") return normalizedKey;
  if (normalizedKey === normalizedRoot) return ".";
  if (normalizedKey.startsWith(`${normalizedRoot}/`)) return normalizedKey.slice(normalizedRoot.length + 1);
  return normalizedKey;
}

function parseResourceLock(lock: string, options: ResourceLockNormalizationOptions): ResourceLock | undefined {
  const separatorIndex = lock.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= lock.length - 1) return undefined;
  const rawKind = lock.slice(0, separatorIndex);
  const kind = normalizeResourceLockKind(rawKind);
  if (!RESOURCE_LOCK_KIND_SET.has(kind as ResourceLock["kind"])) return undefined;
  const rawKey = lock.slice(separatorIndex + 1);
  const key = kind === "workspace" || kind === "path" || kind === "process-slot"
    ? normalizeWorkspaceResourceLockKey(rawKey, options)
    : normalizeResourceLockKey(kind as ResourceLock["kind"], rawKey, options);
  if (!key) return undefined;
  return { kind: kind as ResourceLock["kind"], key };
}

function normalizeResourceLockKind(kind: string): ResourceLock["kind"] | string {
  if (kind === "process") return "process-slot";
  if (kind === "path") return "workspace";
  return kind;
}

function resourceLockKindsConflict(leftKind: string, rightKind: string): boolean {
  if (leftKind === rightKind) return true;
  return (leftKind === "workspace" && rightKind === "process-slot") || (leftKind === "process-slot" && rightKind === "workspace");
}

function isHierarchicalLockKind(kind: string): boolean {
  return kind === "workspace" || kind === "process-slot";
}

function coalesceResourceLocks(locks: readonly ResourceLock[]): readonly ResourceLock[] {
  const kept: ResourceLock[] = [];
  for (const candidate of locks) {
    let covered = false;
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      const existing = kept[index];
      if (!existing || !locksConflict(existing, candidate)) continue;
      if (lockCovers(existing, candidate)) {
        covered = true;
        break;
      }
      if (lockCovers(candidate, existing)) {
        kept.splice(index, 1);
      }
    }
    if (!covered) kept.push(candidate);
  }
  return kept;
}

function locksConflict(left: ResourceLock, right: ResourceLock): boolean {
  return resourceLockStringsConflict(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`);
}

function lockCovers(left: ResourceLock, right: ResourceLock): boolean {
  const leftKind = normalizeResourceLockKind(left.kind);
  const rightKind = normalizeResourceLockKind(right.kind);
  if (!resourceLockKindsConflict(leftKind, rightKind)) return false;
  if (!isHierarchicalLockKind(leftKind) || !isHierarchicalLockKind(rightKind)) {
    return leftKind === rightKind && left.key === right.key;
  }
  return pathKeyContains(left.key, right.key);
}

function pathKeyContains(parent: string, child: string): boolean {
  return parent === child || parent === "." || parent === "/" || child.startsWith(`${parent}/`);
}

function normalizePathLikeLockKey(key: string, options: ResourceLockNormalizationOptions = {}): string {
  const normalized = posix.normalize(key.replace(/\\/g, "/").trim());
  const path = normalized === "."
    ? "."
    : normalized === "/"
      ? "/"
      : normalized.startsWith("./")
        ? normalized.slice(2)
        : normalized.replace(/\/$/, "");
  return options.caseSensitive === false ? path.toLowerCase() : path;
}
