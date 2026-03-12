import type { ArtifactRef, ArtifactWriteInstruction, NormalizedEvent } from './types.js';

const EVENT_TARGET_BYTES = 16 * 1024;
const OBJECT_INLINE_THRESHOLD = 4096;
const DEFAULT_TEXT_PREVIEW = 2000;
const COMMAND_TEXT_PREVIEW = 4000;
const AGGRESSIVE_TEXT_PREVIEW = 1000;

const PRIORITY_TEXT_LIMITS = new Map<string, number>([
  ['/stdout', COMMAND_TEXT_PREVIEW],
  ['/stderr', COMMAND_TEXT_PREVIEW],
  ['/output', COMMAND_TEXT_PREVIEW],
  ['/content', DEFAULT_TEXT_PREVIEW],
  ['/text', DEFAULT_TEXT_PREVIEW],
  ['/final_response', DEFAULT_TEXT_PREVIEW],
  ['/summary', DEFAULT_TEXT_PREVIEW],
  ['/aggregated_output', COMMAND_TEXT_PREVIEW],
  ['/input/content', DEFAULT_TEXT_PREVIEW],
  ['/input/old_string', DEFAULT_TEXT_PREVIEW],
  ['/input/new_string', DEFAULT_TEXT_PREVIEW],
]);

const PRIORITY_STRUCTURED_PATHS = [
  '/raw_tool_use_result',
  '/arguments',
  '/result',
  '/error',
  '/changes',
];

const PROTECTED_PATHS = new Set([
  '/command',
  '/tool',
  '/tool_use_id',
  '/exit_code',
  '/status',
  '/is_error',
  '/interrupted',
  '/file_path',
  '/backend_session_id',
  '/thread_id',
  '/context_id',
  '/task_id',
  '/agent_url',
  '/agent_name',
  '/conversation_id',
  '/artifact_refs',
]);

interface SanitizedEventResult {
  event: NormalizedEvent;
  artifacts: ArtifactWriteInstruction[];
}

interface CandidateField {
  path: string;
  size: number;
}

export function sanitizeEvent(event: NormalizedEvent): SanitizedEventResult {
  const sanitized = structuredClone(event);
  const artifacts: ArtifactWriteInstruction[] = [];
  const extractedPaths = new Set<string>();

  for (const [fieldPath, previewChars] of PRIORITY_TEXT_LIMITS) {
    maybeExtractField(sanitized.data, fieldPath, previewChars, artifacts, extractedPaths);
  }
  for (const fieldPath of PRIORITY_STRUCTURED_PATHS) {
    maybeExtractField(sanitized.data, fieldPath, DEFAULT_TEXT_PREVIEW, artifacts, extractedPaths);
  }

  while (serializedBytes(sanitized) > EVENT_TARGET_BYTES) {
    const candidate = findLargestCandidate(sanitized.data, extractedPaths);
    if (!candidate) {
      break;
    }
    maybeExtractField(
      sanitized.data,
      candidate.path,
      AGGRESSIVE_TEXT_PREVIEW,
      artifacts,
      extractedPaths,
      true,
    );
    if (extractedPaths.has(candidate.path) === false) {
      break;
    }
  }

  if (artifacts.length > 0) {
    sanitized.data.artifact_refs = {};
  }

  return { event: sanitized, artifacts };
}

export function attachArtifactRefs(
  event: NormalizedEvent,
  refs: Record<string, ArtifactRef>,
): NormalizedEvent {
  if (Object.keys(refs).length === 0) {
    return event;
  }
  return {
    ...event,
    data: {
      ...event.data,
      artifact_refs: refs,
    },
  };
}

function maybeExtractField(
  data: Record<string, unknown>,
  fieldPath: string,
  previewChars: number,
  artifacts: ArtifactWriteInstruction[],
  extractedPaths: Set<string>,
  aggressive = false,
): void {
  if (extractedPaths.has(fieldPath) || PROTECTED_PATHS.has(fieldPath)) {
    return;
  }
  const current = getAtPointer(data, fieldPath);
  if (current === undefined) {
    return;
  }

  if (typeof current === 'string') {
    const totalBytes = Buffer.byteLength(current, 'utf8');
    if (totalBytes <= previewChars) {
      return;
    }
    setAtPointer(data, fieldPath, truncateText(current, previewChars));
    artifacts.push({
      field_path: fieldPath,
      mime: 'text/plain',
      encoding: 'utf-8',
      content: current,
      total_chars: current.length,
      truncated: true,
    });
    extractedPaths.add(fieldPath);
    return;
  }

  if (current && typeof current === 'object') {
    const serialized = JSON.stringify(current);
    const totalBytes = Buffer.byteLength(serialized, 'utf8');
    const threshold = aggressive ? 1024 : OBJECT_INLINE_THRESHOLD;
    if (totalBytes <= threshold) {
      return;
    }
    setAtPointer(data, fieldPath, summarizeStructuredValue(current));
    artifacts.push({
      field_path: fieldPath,
      mime: 'application/json',
      encoding: 'utf-8',
      content: serialized,
      truncated: true,
    });
    extractedPaths.add(fieldPath);
  }
}

function findLargestCandidate(
  root: Record<string, unknown>,
  extractedPaths: Set<string>,
): CandidateField | null {
  const candidates: CandidateField[] = [];
  collectCandidates(root, '', candidates, extractedPaths);
  candidates.sort((left, right) => right.size - left.size);
  return candidates[0] ?? null;
}

function collectCandidates(
  value: unknown,
  currentPath: string,
  candidates: CandidateField[],
  extractedPaths: Set<string>,
): void {
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && currentPath && !PROTECTED_PATHS.has(currentPath) && !extractedPaths.has(currentPath)) {
      const size = Buffer.byteLength(value, 'utf8');
      if (size > AGGRESSIVE_TEXT_PREVIEW) {
        candidates.push({ path: currentPath, size });
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    if (currentPath && !PROTECTED_PATHS.has(currentPath) && !extractedPaths.has(currentPath)) {
      const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
      if (size > 1024) {
        candidates.push({ path: currentPath, size });
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      collectCandidates(value[index], `${currentPath}/${index}`, candidates, extractedPaths);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'artifact_refs') {
      continue;
    }
    const nextPath = `${currentPath}/${escapePointerToken(key)}`;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      const size = Buffer.byteLength(JSON.stringify(child), 'utf8');
      if (!PROTECTED_PATHS.has(nextPath) && !extractedPaths.has(nextPath) && size > 1024) {
        candidates.push({ path: nextPath, size });
      }
    }
    collectCandidates(child, nextPath, candidates, extractedPaths);
  }
}

function summarizeStructuredValue(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      artifact_summary: {
        original_type: 'array',
        item_count: value.length,
        preview: value.slice(0, 3),
      },
    };
  }

  const objectValue = value as Record<string, unknown>;
  return {
    artifact_summary: {
      original_type: 'object',
      key_count: Object.keys(objectValue).length,
      preview_keys: Object.keys(objectValue).slice(0, 8),
    },
  };
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n...[truncated, see artifact_refs]`;
}

function getAtPointer(root: Record<string, unknown>, pointer: string): unknown {
  const tokens = parsePointer(pointer);
  let current: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function setAtPointer(root: Record<string, unknown>, pointer: string, value: unknown): void {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) {
    throw new Error('Cannot replace root event data');
  }

  let current: unknown = root;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    if (Array.isArray(current)) {
      current = current[Number(token)];
      continue;
    }
    current = (current as Record<string, unknown>)[token];
  }

  const last = tokens.at(-1) as string;
  if (Array.isArray(current)) {
    current[Number(last)] = value;
    return;
  }
  (current as Record<string, unknown>)[last] = value;
}

function parsePointer(pointer: string): string[] {
  if (!pointer.startsWith('/')) {
    throw new Error(`Invalid field_path: ${pointer}`);
  }
  return pointer
    .split('/')
    .slice(1)
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function escapePointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

function serializedBytes(event: NormalizedEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}
