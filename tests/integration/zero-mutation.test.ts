import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CouchDbTestHarness } from './couchdb-harness.js';
import { probeRemoteDatabase } from '../../src/livesync/inspector.js';
import { ZeroMutationVerifier } from '../../src/livesync/zero-mutation.js';
import {
  createGuardedFetch,
  MutationAttemptBlockedError,
} from '../../src/security/transport-guard.js';

describe('Zero-Mutation CouchDB Admission Integration Tests', () => {
  const harness = new CouchDbTestHarness();
  const dbName = 'test-admission-vault';

  beforeAll(async () => {
    await harness.start();
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, {
      version: 12,
      locked: false,
      pbkdf2salt: 'test-salt-abc',
      hashAlgorithm: 'sha256',
      syncinfo: 'test-encrypted-payload',
      sampleNotes: {
        'Note 1.md': '# Note 1\nContent of note 1',
        'Note 2.md': '# Note 2\nContent of note 2',
      },
    });
  }, 120000);

  afterAll(async () => {
    await harness.stop();
  }, 60000);

  it('mathematically proves zero remote mutation across read-only inspection', async () => {
    const baseUrl = harness.getBaseUrl();
    const credentials = harness.getCredentials();

    const guardedFetch = createGuardedFetch({
      allowedBaseUrl: baseUrl,
      databaseName: dbName,
    });

    // 1. Capture snapshot before inspection
    const preSnapshot = await ZeroMutationVerifier.captureSnapshot(
      guardedFetch,
      baseUrl,
      dbName,
      credentials
    );

    // 2. Perform comprehensive remote inspection
    const probeResult = await probeRemoteDatabase(
      guardedFetch,
      baseUrl,
      dbName,
      credentials
    );

    expect(probeResult.databaseInfo.docCount).toBe(preSnapshot.docCount);
    expect(probeResult.versionDoc?.version).toBe(12);
    expect(probeResult.milestoneDoc?.locked).toBe(false);
    expect(probeResult.syncParamsDoc?.pbkdf2salt).toBe('test-salt-abc');
    expect(probeResult.sampleDocs.length).toBeGreaterThan(0);

    // 3. Capture snapshot after inspection
    const postSnapshot = await ZeroMutationVerifier.captureSnapshot(
      guardedFetch,
      baseUrl,
      dbName,
      credentials
    );

    // 4. Assert mathematical zero-mutation
    expect(() => {
      ZeroMutationVerifier.assertNoMutation(preSnapshot, postSnapshot);
    }).not.toThrow();

    expect(preSnapshot.updateSeq).toBe(postSnapshot.updateSeq);
    expect(preSnapshot.docCount).toBe(postSnapshot.docCount);
    expect(preSnapshot.revisions).toEqual(postSnapshot.revisions);
  });

  it('mechanically blocks mutating requests and ensures zero database impact', async () => {
    const baseUrl = harness.getBaseUrl();
    const credentials = harness.getCredentials();

    const guardedFetch = createGuardedFetch({
      allowedBaseUrl: baseUrl,
      databaseName: dbName,
    });

    const preSnapshot = await ZeroMutationVerifier.captureSnapshot(
      guardedFetch,
      baseUrl,
      dbName,
      credentials
    );

    // Attempt PUT through guardedFetch
    const putPromise = guardedFetch(
      new URL(`/${dbName}/unauthorized_doc`, baseUrl).toString(),
      {
        method: 'PUT',
        body: JSON.stringify({ title: 'Illegal write' }),
      }
    );

    await expect(putPromise).rejects.toThrow(MutationAttemptBlockedError);

    // Verify snapshot is completely untouched
    const postSnapshot = await ZeroMutationVerifier.captureSnapshot(
      guardedFetch,
      baseUrl,
      dbName,
      credentials
    );

    expect(() => {
      ZeroMutationVerifier.assertNoMutation(preSnapshot, postSnapshot);
    }).not.toThrow();
  });
});
