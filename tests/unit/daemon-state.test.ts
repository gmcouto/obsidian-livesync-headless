import { describe, it, expect } from 'vitest';
import { DaemonStateMachine, DaemonStateEvent } from '../../src/daemon/daemon-state.js';

describe('DaemonStateMachine', () => {
  it('initializes in INITIALIZING state', () => {
    const sm = new DaemonStateMachine();
    expect(sm.getState()).toBe('INITIALIZING');
    expect(sm.isWritePermitted()).toBe(false);
    expect(sm.isTerminal()).toBe(false);
  });

  it('permits writes only in HEALTHY_BIDIRECTIONAL state', () => {
    const sm = new DaemonStateMachine();

    sm.transitionTo('CATCHING_UP');
    expect(sm.isWritePermitted()).toBe(false);
    expect(sm.isReadPermitted()).toBe(true);

    sm.transitionTo('HEALTHY_BIDIRECTIONAL');
    expect(sm.isWritePermitted()).toBe(true);
    expect(sm.isReadPermitted()).toBe(true);

    sm.transitionTo('DEGRADED_READ_ONLY', 'Write grant revoked');
    expect(sm.isWritePermitted()).toBe(false);
    expect(sm.isReadPermitted()).toBe(true);

    sm.transitionTo('BLOCKED', 'Database schema corruption');
    expect(sm.isWritePermitted()).toBe(false);
    expect(sm.isReadPermitted()).toBe(false);
  });

  it('emits transition events on state changes', () => {
    const sm = new DaemonStateMachine();
    const events: DaemonStateEvent[] = [];

    sm.on('transition', (e) => events.push(e));

    sm.transitionTo('CATCHING_UP');
    sm.transitionTo('HEALTHY_BIDIRECTIONAL');
    sm.transitionTo('DEGRADED_READ_ONLY', 'Security drift');

    expect(events.length).toBe(3);
    expect(events[2]).toMatchObject({
      previousState: 'HEALTHY_BIDIRECTIONAL',
      newState: 'DEGRADED_READ_ONLY',
      reason: 'Security drift',
    });
  });

  it('prohibits transitions once in terminal STOPPED state', () => {
    const sm = new DaemonStateMachine();
    sm.transitionTo('STOPPED');
    expect(sm.isTerminal()).toBe(true);

    expect(() => sm.transitionTo('HEALTHY_BIDIRECTIONAL')).toThrow(
      'Cannot transition from terminal state STOPPED to HEALTHY_BIDIRECTIONAL'
    );
  });
});
