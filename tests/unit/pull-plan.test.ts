import { describe, it, expect } from 'vitest';
import {
  buildPullPlan,
  observationFromDecodeFailure,
  serializePullActions,
} from '../../src/domain/pull-plan.js';
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

  it('maps a decrypt failure observation to a block naming decrypt or authentication', () => {
    const observation = observationFromDecodeFailure({
      ok: false,
      code: 'DECRYPT_FAILED',
      message: 'Passphrase authentication failed: tag mismatch',
      id: 'Welcome.md',
      path: 'Welcome.md',
    });
    const plan = buildPullPlan([observation]);

    expect(plan).toHaveLength(1);
    expect(plan[0]?.kind).toBe('block');
    if (plan[0]?.kind === 'block') {
      expect(plan[0].code.toLowerCase()).toMatch(/decrypt|authentication/);
      expect(plan[0].message.toLowerCase()).toMatch(/decrypt|passphrase|authentication/);
      expect(plan[0].suggestion).toEqual(expect.any(String));
    }
    expect(plan.some((action) => action.kind === 'create')).toBe(false);
  });

  it('blocks missing chunks and size mismatches without creating files', () => {
    const plan = buildPullPlan([
      observationFromDecodeFailure({
        ok: false,
        code: 'MISSING_CHUNK',
        message: "Missing child chunk 'h:gone'",
        id: 'Chunked.md',
        path: 'Chunked.md',
      }),
      observationFromDecodeFailure({
        ok: false,
        code: 'SIZE_MISMATCH',
        message: 'Assembled size 4 does not match metadata size 99',
        id: 'Sized.md',
        path: 'Sized.md',
      }),
    ]);

    expect(plan).toHaveLength(2);
    expect(plan.every((action) => action.kind === 'block')).toBe(true);
    expect(plan.map((action) => (action.kind === 'block' ? action.code : ''))).toEqual([
      'MISSING_CHUNK',
      'SIZE_MISMATCH',
    ]);
    expect(plan.some((action) => action.kind === 'create')).toBe(false);
    for (const action of plan) {
      if (action.kind === 'block') {
        expect(action.suggestion).toEqual(expect.any(String));
      }
    }
  });

  it('blocks path identity and unsupported document shape failures', () => {
    const plan = buildPullPlan([
      observationFromDecodeFailure({
        ok: false,
        code: 'PATH_ID_MISMATCH',
        message: "path2id for 'Welcome.md' is 'other', not document id 'f:abc'",
        id: 'f:abc',
        path: 'Welcome.md',
      }),
      observationFromDecodeFailure({
        ok: false,
        code: 'UNSUPPORTED_NOTE_SHAPE',
        message: "Unsupported note type 'internalfile'",
        id: 'weird',
        path: 'weird',
      }),
    ]);

    expect(plan).toHaveLength(2);
    expect(plan.every((action) => action.kind === 'block')).toBe(true);
    expect(plan.map((action) => (action.kind === 'block' ? action.code : ''))).toEqual([
      'PATH_ID_MISMATCH',
      'UNSUPPORTED_NOTE_SHAPE',
    ]);
  });

  it('creates notes, plain, and newnote payloads and skips logical deletes', () => {
    const notes = new TextEncoder().encode('legacy');
    const plain = new TextEncoder().encode('plain-text');
    const binary = new Uint8Array([0, 1, 2, 3]);
    const plan = buildPullPlan([
      {
        kind: 'note',
        path: 'Legacy.md',
        sourceRevision: '1-n',
        type: 'notes',
        deleted: false,
        bytes: notes,
      },
      {
        kind: 'note',
        path: 'Plain.md',
        sourceRevision: '1-p',
        type: 'plain',
        deleted: false,
        bytes: plain,
      },
      {
        kind: 'note',
        path: 'Photo.bin',
        sourceRevision: '1-b',
        type: 'newnote',
        deleted: false,
        bytes: binary,
      },
      {
        kind: 'note',
        path: 'Gone.md',
        sourceRevision: '2-del',
        type: 'plain',
        deleted: true,
        bytes: plain,
      },
    ]);

    expect(plan.map((action) => action.kind)).toEqual([
      'create',
      'create',
      'create',
      'skip-logical-delete',
    ]);
    expect(plan.filter((action) => action.kind === 'create').map((action) => {
      return action.kind === 'create' ? action.path : '';
    })).toEqual(['Legacy.md', 'Plain.md', 'Photo.bin']);
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
