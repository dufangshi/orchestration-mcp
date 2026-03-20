import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
type CodexApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted';
type ClaudePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';

const CODEX_SANDBOX_MODES: CodexSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
const CODEX_APPROVAL_POLICIES: CodexApprovalPolicy[] = ['never', 'on-request', 'on-failure', 'untrusted'];
const CLAUDE_PERMISSION_MODES: ClaudePermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
];

export interface CodexRuntimeOptions {
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  networkAccessEnabled: boolean;
}

export interface ClaudeRuntimeOptions {
  permissionMode: ClaudePermissionMode;
  allowDangerouslySkipPermissions?: boolean;
}

export function getCodexRuntimeOptions(): CodexRuntimeOptions {
  const sandboxMode = getEnumEnvValue(
    'ORCHESTRATOR_CODEX_SANDBOX_MODE',
    CODEX_SANDBOX_MODES,
    'danger-full-access',
  );
  const approvalPolicy = getEnumEnvValue(
    'ORCHESTRATOR_CODEX_APPROVAL_POLICY',
    CODEX_APPROVAL_POLICIES,
    'never',
  );
  const networkAccessEnabled = getBooleanEnvValue('ORCHESTRATOR_CODEX_NETWORK_ACCESS_ENABLED', true);

  return {
    sandboxMode,
    approvalPolicy,
    networkAccessEnabled,
  };
}

export function getClaudeRuntimeOptions(): ClaudeRuntimeOptions {
  const permissionMode = getEnumEnvValue(
    'ORCHESTRATOR_CLAUDE_PERMISSION_MODE',
    CLAUDE_PERMISSION_MODES,
    'bypassPermissions',
  );
  const allowDangerouslySkipPermissions = getOptionalBooleanEnvValue(
    'ORCHESTRATOR_CLAUDE_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS',
  );

  return {
    permissionMode,
    allowDangerouslySkipPermissions:
      allowDangerouslySkipPermissions ?? (permissionMode === 'bypassPermissions' ? true : undefined),
  };
}

function getEnumEnvValue<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = getRuntimeEnvValue(key);
  if (!raw) {
    return fallback;
  }
  if (allowed.includes(raw as T)) {
    return raw as T;
  }
  throw new Error(`${key} must be one of: ${allowed.join(', ')}`);
}

function getBooleanEnvValue(key: string, fallback: boolean): boolean {
  return getOptionalBooleanEnvValue(key) ?? fallback;
}

function getOptionalBooleanEnvValue(key: string): boolean | undefined {
  const raw = getRuntimeEnvValue(key);
  if (!raw) {
    return undefined;
  }
  if (raw === '1' || raw.toLowerCase() === 'true') {
    return true;
  }
  if (raw === '0' || raw.toLowerCase() === 'false') {
    return false;
  }
  throw new Error(`${key} must be one of: 1, 0, true, false`);
}

function getRuntimeEnvValue(key: string): string | undefined {
  const liveValue = normalizeEnvValue(process.env[key]);
  if (liveValue !== undefined) {
    return liveValue;
  }
  const fileEnv = readLocalEnvFile();
  return normalizeEnvValue(fileEnv[key]);
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readLocalEnvFile(): Record<string, string> {
  const filePath = process.env.ORCHESTRATOR_ENV_FILE?.trim() || path.join(process.cwd(), '.env');
  if (!existsSync(filePath)) {
    return {};
  }

  const raw = readFileSync(filePath, 'utf8');
  const entries: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    entries[key] = parseEnvValue(rawValue);
  }
  return entries;
}

function parseEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  const commentIndex = trimmed.indexOf(' #');
  return commentIndex >= 0 ? trimmed.slice(0, commentIndex).trim() : trimmed;
}
