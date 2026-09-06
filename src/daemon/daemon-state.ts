import { EventEmitter } from 'node:events';

export type DaemonState =
  | 'INITIALIZING'
  | 'CATCHING_UP'
  | 'HEALTHY_BIDIRECTIONAL'
  | 'DEGRADED_READ_ONLY'
  | 'BLOCKED'
  | 'STOPPING'
  | 'STOPPED';

export interface DaemonStateEvent {
  readonly previousState: DaemonState;
  readonly newState: DaemonState;
  readonly reason?: string;
  readonly timestamp: number;
}

export class DaemonStateMachine extends EventEmitter {
  private currentState: DaemonState = 'INITIALIZING';

  getState(): DaemonState {
    return this.currentState;
  }

  isWritePermitted(): boolean {
    return this.currentState === 'HEALTHY_BIDIRECTIONAL';
  }

  isReadPermitted(): boolean {
    return (
      this.currentState === 'HEALTHY_BIDIRECTIONAL' ||
      this.currentState === 'DEGRADED_READ_ONLY' ||
      this.currentState === 'CATCHING_UP'
    );
  }

  isTerminal(): boolean {
    return this.currentState === 'STOPPED';
  }

  transitionTo(newState: DaemonState, reason?: string): void {
    if (this.currentState === newState) {
      return;
    }

    if (this.currentState === 'STOPPED') {
      throw new Error(`Cannot transition from terminal state STOPPED to ${newState}`);
    }

    const previousState = this.currentState;
    this.currentState = newState;

    const event: DaemonStateEvent = {
      previousState,
      newState,
      reason,
      timestamp: Date.now(),
    };

    this.emit('transition', event);
  }
}
