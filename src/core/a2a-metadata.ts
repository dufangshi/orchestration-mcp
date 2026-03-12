const ORCHESTRATION_METADATA_KEY = 'nanobot_orchestrator';

interface OrchestrationMetadataInput {
  cwd: string;
  runId?: string;
  sessionId?: string;
}

export function attachOrchestrationMetadata(
  metadata: Record<string, unknown> | undefined,
  input: OrchestrationMetadataInput,
): Record<string, unknown> {
  const nextMetadata = isRecord(metadata) ? { ...metadata } : {};
  const existing = isRecord(nextMetadata[ORCHESTRATION_METADATA_KEY])
    ? nextMetadata[ORCHESTRATION_METADATA_KEY]
    : {};

  nextMetadata[ORCHESTRATION_METADATA_KEY] = {
    ...existing,
    cwd: input.cwd,
    ...(input.runId ? { run_id: input.runId } : {}),
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
  };

  return nextMetadata;
}

export function extractOrchestrationCwd(metadata: unknown): string | null {
  if (!isRecord(metadata)) {
    return null;
  }
  const orchestration = metadata[ORCHESTRATION_METADATA_KEY];
  if (!isRecord(orchestration) || typeof orchestration.cwd !== 'string' || !orchestration.cwd) {
    return null;
  }
  return orchestration.cwd;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
