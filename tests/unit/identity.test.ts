import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getBuildIdentity,
  formatIdentityHuman,
  formatIdentityJson,
} from '../../src/diagnostics/identity.js';

describe('BuildIdentity Diagnostic Engine', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.GIT_COMMIT;
    delete process.env.BUILD_TIMESTAMP;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('provides default pinned build identity metadata', () => {
    const identity = getBuildIdentity();

    expect(identity.name).toBe('obsidian-livesync-headless');
    expect(identity.version).toBe('0.1.0');
    expect(identity.liveSyncCompatibility).toBe('1.0.23');
    expect(identity.commonlibVersion).toBe('0.1.21');
    expect(identity.targetCouchDbVersion).toBe('3.5.2');
    expect(identity.gitCommit).toBe('release');
    expect(identity.buildTimestamp).toBe('2026-09-06T00:00:00.000Z');
    expect(identity.dependencyOverrides).toEqual({
      'pouchdb-core': { uuid: '11.1.1' },
      'pouchdb-utils': { uuid: '11.1.1' },
    });
    expect(identity.runtime.nodeVersion).toBe(process.version);
    expect(identity.runtime.platform).toBe(process.platform);
    expect(identity.runtime.arch).toBe(process.arch);
    expect(typeof identity.runtime.sea).toBe('boolean');
  });

  it('respects GIT_COMMIT and BUILD_TIMESTAMP environment variables when set', () => {
    process.env.GIT_COMMIT = 'abc1234def';
    process.env.BUILD_TIMESTAMP = '2026-09-06T12:34:56.789Z';

    const identity = getBuildIdentity();
    expect(identity.gitCommit).toBe('abc1234def');
    expect(identity.buildTimestamp).toBe('2026-09-06T12:34:56.789Z');
  });

  it('formats human-readable identity banner with all fields', () => {
    const identity = getBuildIdentity();
    const humanOutput = formatIdentityHuman(identity);

    expect(humanOutput).toContain('OBSIDIAN LIVESYNC HEADLESS — BUILD & COMPATIBILITY IDENTITY');
    expect(humanOutput).toContain('Client Version:           v0.1.0');
    expect(humanOutput).toContain('LiveSync Compatibility:   1.0.23');
    expect(humanOutput).toContain('Commonlib Version:        0.1.21');
    expect(humanOutput).toContain('Target CouchDB:           3.5.2');
    expect(humanOutput).toContain('Git Commit:               release');
    expect(humanOutput).toContain('Build Timestamp:          2026-09-06T00:00:00.000Z');
    expect(humanOutput).toContain(`Node ${process.version}`);
    expect(humanOutput).toContain('pouchdb-core -> uuid: 11.1.1');
    expect(humanOutput).toContain('pouchdb-utils -> uuid: 11.1.1');
  });

  it('formats structured JSON Lines identity report', () => {
    const identity = getBuildIdentity();
    const jsonOutput = formatIdentityJson(identity);

    expect(jsonOutput.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(jsonOutput.trim());

    expect(parsed.type).toBe('version_identity');
    expect(parsed.name).toBe('obsidian-livesync-headless');
    expect(parsed.version).toBe('0.1.0');
    expect(parsed.liveSyncCompatibility).toBe('1.0.23');
    expect(parsed.commonlibVersion).toBe('0.1.21');
    expect(parsed.targetCouchDbVersion).toBe('3.5.2');
    expect(parsed.gitCommit).toBe('release');
    expect(parsed.buildTimestamp).toBe('2026-09-06T00:00:00.000Z');
    expect(parsed.dependencyOverrides).toEqual({
      'pouchdb-core': { uuid: '11.1.1' },
      'pouchdb-utils': { uuid: '11.1.1' },
    });
    expect(parsed.runtime).toBeDefined();
  });
});
