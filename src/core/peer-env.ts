import path from 'node:path';

import type { AdapterSpawnParams } from './types.js';

export interface PeerIdentity {
  agentName: string;
  sessionId: string;
  cwd: string;
}

export function getPeerIdentity(params: AdapterSpawnParams): PeerIdentity {
  return {
    agentName: params.session.agentName ?? `agent-${params.session.sessionId.slice(0, 8)}`,
    sessionId: params.session.sessionId,
    cwd: params.cwd,
  };
}

export function buildPeerEnvironment(params: AdapterSpawnParams): Record<string, string> {
  const identity = getPeerIdentity(params);
  const baseEnv = process.env;
  const cwdPath = identity.cwd;
  const existingPath = baseEnv.PATH ?? '';
  const pathSegments = existingPath
    .split(path.delimiter)
    .filter((segment) => segment.length > 0);

  if (!pathSegments.includes(cwdPath)) {
    pathSegments.unshift(cwdPath);
  }

  return {
    ...Object.fromEntries(
      Object.entries(baseEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    PATH: pathSegments.join(path.delimiter),
    PEER_NAME: identity.agentName,
    PEER_SESSION_ID: identity.sessionId,
    PEER_CWD: identity.cwd,
  };
}
