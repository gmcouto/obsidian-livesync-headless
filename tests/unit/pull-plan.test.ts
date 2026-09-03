import { describe, it, expect } from 'vitest';
import { buildPullPlan, serializePullActions } from '../../src/domain/pull-plan.js';
import {
  formatPullJsonLinesReport,
  type PullReport,
} from '../../src/diagnostics/formatters.js';
import { OutcomeCategory } from '../../src/diagnostics/outcomes.js';

describe('buildPullPlan', () => {
  it('creates a create action for one decoded notes leaf that is not deleted', () => {
    const bytes = new TextEncoder().encode('Welcome to the vault');
    const plan = buildPullPlan([
      {
        kind: 'note',
        path: 'Welcome.md',
        sourceRevision: '1-abc',
        type: 'notes',
        deleted: false,
        bytes,
      },
    ]);

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      kind: 'create',
      path: 'Welcome.md',
      sourceRevision: '1-abc',
    });
    if (plan[0].kind === 'create') {
      expect(plan[0].bytes).toEqual(bytes);
    }
  });

  it('skips leaf and versioninfo documents as skip-special', () => {
    const plan = buildPullPlan([
      { kind: 'special', id: 'h:chunk-one', type: 'leaf' },
      { kind: 'special', id: 'obsydian_livesync_version', type: 'versioninfo' },
    ]);

    expect(plan).toEqual([
      { kind: 'skip-special', id: 'h:chunk-one', type: 'leaf' },
      { kind: 'skip-special', id: 'obsydian_livesync_version', type: 'versioninfo' },
    ]);
  });

  it('skips LiveSync logical deletions without treating them as file bodies', () => {
    const plan = buildPullPlan([
      {
        kind: 'note',
        path: 'Gone.md',
        sourceRevision: '2-del',
        type: 'notes',
        deleted: true,
        bytes: new TextEncoder().encode('should-not-materialize'),
      },
    ]);

    expect(plan).toEqual([
      { kind: 'skip-logical-delete', path: 'Gone.md', sourceRevision: '2-del' },
    ]);
  });

  it('omits assembled bytes from serialized actions', () => {
    const bytes = new TextEncoder().encode('secret-body');
    const serialized = serializePullActions([
      { kind: 'create', path: 'Welcome.md', sourceRevision: '1-abc', bytes },
    ]);

    expect(serialized[0]).toMatchObject({
      kind: 'create',
      path: 'Welcome.md',
      sourceRevision: '1-abc',
      byteLength: bytes.byteLength,
    });
    expect(serialized[0]).not.toHaveProperty('bytes');
    expect(JSON.stringify(serialized)).not.toContain('secret-body');
  });
});

describe('formatPullJsonLinesReport', () => {
  it('emits a parseable pull_report JSON line without payload bytes', () => {
    const report: PullReport = {
      type: 'pull_report',
      outcome: OutcomeCategory.SUCCESS,
      dryRun: true,
      remoteFingerprint: 'abc',
      negotiatedSettingsHash: 'def',
      adoptedTweaks: { hashAlg: 'sha256' },
      actions: [
        {
          kind: 'create',
          path: 'Welcome.md',
          sourceRevision: '1-abc',
          byteLength: 5,
          contentSha256: 'deadbeef',
        },
      ],
      blockers: [],
      zeroMutationVerified: true,
      preUpdateSeq: '1',
      postUpdateSeq: '1',
    };

    const line = formatPullJsonLinesReport(report);
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe('pull_report');
    expect(parsed.dryRun).toBe(true);
    expect(parsed.actions[0].contentSha256).toBe('deadbeef');
    expect(parsed).not.toHaveProperty('bytes');
    expect(line.endsWith('\n')).toBe(true);
  });
});
