import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';

import type { AgentMessage } from './types.js';

export interface ResolvedProfile {
  path: string;
  content: string;
}

export async function loadResolvedProfile(
  profilePath: string | undefined,
  cwd: string,
): Promise<ResolvedProfile | undefined> {
  if (!profilePath) {
    return undefined;
  }

  const resolvedPath = await resolveProfilePath(profilePath, cwd);
  const content = (await readFile(resolvedPath, 'utf8')).trim();
  if (!content) {
    throw new Error(`profile is empty: ${resolvedPath}`);
  }

  return {
    path: resolvedPath,
    content,
  };
}

export function formatProfileSystemPrompt(profile: ResolvedProfile): string {
  return [
    `Profile source: ${profile.path}`,
    '',
    profile.content,
  ].join('\n');
}

export function injectSystemPromptIntoPrompt(prompt: string, systemPrompt: string): string {
  return [
    buildInlineSystemPromptContext(systemPrompt),
    '',
    'User request:',
    prompt,
  ].join('\n');
}

export function injectSystemPromptIntoMessage(
  message: AgentMessage,
  systemPrompt: string,
): AgentMessage {
  return {
    role: 'user',
    parts: [
      {
        type: 'text',
        text: buildInlineSystemPromptContext(systemPrompt),
      },
      ...message.parts,
    ],
    metadata: message.metadata,
  };
}

async function resolveProfilePath(profilePath: string, cwd: string): Promise<string> {
  const candidates = path.isAbsolute(profilePath)
    ? [profilePath]
    : [path.resolve(process.cwd(), profilePath), path.resolve(cwd, profilePath)];

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(
    `profile file not found or unreadable: ${profilePath} (checked: ${candidates.join(', ')})`,
  );
}

function buildInlineSystemPromptContext(systemPrompt: string): string {
  return [
    'System instructions for this run:',
    'Follow the instructions below with higher priority than the user request unless they conflict with platform, tool, or safety constraints.',
    '',
    '<SYSTEM_PROMPT>',
    systemPrompt.trim(),
    '</SYSTEM_PROMPT>',
  ].join('\n');
}
