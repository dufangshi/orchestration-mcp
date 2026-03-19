export interface DaemonState {
  pid: number;
  started_at: string;
  socket_path: string;
}

export interface DaemonStatus {
  status: 'running' | 'stopped';
  daemon: DaemonState | null;
  reason?: string;
}

export interface DaemonStartResult extends DaemonStatus {
  created: boolean;
}

export interface DaemonStopResult {
  stopped: boolean;
  previously_running: boolean;
}
