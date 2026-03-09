import type { AdapterSpawnParams, AdapterRunHandle, BackendKind, RunAdapter } from '../core/types.js';

export type { AdapterSpawnParams, AdapterRunHandle, BackendKind, RunAdapter };

export abstract class BaseRunAdapter implements RunAdapter {
  abstract readonly backend: BackendKind;

  abstract spawn(params: AdapterSpawnParams): Promise<AdapterRunHandle>;

  abstract cancel(handle: AdapterRunHandle): Promise<void>;
}
