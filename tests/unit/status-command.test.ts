import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runStatusCommand, formatStatusHuman, formatStatusJson, type StatusReport } from '../../src/cli/commands/status.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { AdmissionRepository } from '../../src/storage/admission-repo.js';
import { WriteGrantRepo } from '../../src/storage/write-grant-repo.js';
import { CheckpointRepository } from '../../src/storage/checkpoint-repo.js';
import { ProvenanceRepository } from '../../src/storage/provenance-repo.js';
import { QuarantineRepository } from '../../src/storage/quarantine-repo.js';
import { OutcomeCategory, EXIT_CODES } from '../../src/diagnostics/outcomes.js';

describe('Local Status Command (runStatusCommand)', () => {
  let tempDir: string;
  let configPath: string;
  let vaultDir: string;
  let stateDbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livesync-status-test-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });

    stateDbPath = path.join(tempDir, 'state', 'state.db');
    configPath = path.join(tempDir, 'config.yaml');

    const configContent = `
vault:
  path: ${vaultDir}
remote:
  url: http://127.0.0.1:5984
  database: test_db
  username: user
  password: pass
state:
  path: ${stateDbPath}
`;
    fs.writeFileSync(configPath, configContent, 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('handles configuration load errors cleanly', async () => {
    let output = '';
    const stdout = (msg: string) => {
      output += msg;
    };

    const exitCode = await runStatusCommand({
      configPath: path.join(tempDir, 'non-existent-config.yaml'),
      json: true,
      stdout,
    });

    expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
    const parsed = JSON.parse(output.trim());
    expect(parsed.type).toBe('status_report');
    expect(parsed.outcome).toBe(OutcomeCategory.CONFIG_ERROR);
  });

  it('reports unconfigured/clean state when state.db does not exist', async () => {
    let output = '';
    const stdout = (msg: string) => {
      output += msg;
    };

    const exitCode = await runStatusCommand({
      configPath,
      json: true,
      stdout,
    });

    expect(exitCode).toBe(EXIT_CODES.SUCCESS);
    const parsed = JSON.parse(output.trim());
    expect(parsed.type).toBe('status_report');
    expect(parsed.outcome).toBe(OutcomeCategory.SUCCESS);
    expect(parsed.databaseExists).toBe(false);
    expect(parsed.admission.admitted).toBe(false);
    expect(parsed.writeGrant.active).toBe(false);
    expect(parsed.checkpoint.hasCheckpoint).toBe(false);
    expect(parsed.stats.trackedFilesCount).toBe(0);
    expect(parsed.stats.quarantineFilesCount).toBe(0);
  });

  it('inspects admitted database with active write grant and checkpoints', async () => {
    const db = openDatabase(stateDbPath);
    const admissionRepo = new AdmissionRepository(db);
    const writeGrantRepo = new WriteGrantRepo(db);
    const checkpointRepo = new CheckpointRepository(db);
    const provRepo = new ProvenanceRepository(db);
    const quarRepo = new QuarantineRepository(db);

    const remoteFingerprint = 'fp-test-123';
    admissionRepo.saveAdmission({
      remoteFingerprint,
      couchdbUrl: 'http://user:pass@127.0.0.1:5984',
      databaseName: 'test_db',
      couchdbVersion: '3.5.2',
      versionInfoRev: '1-rev',
      milestoneRev: '1-mile',
      syncParamsRev: '1-params',
      negotiatedSettingsHash: 'hash-abc',
      negotiatedSettingsJson: '{}',
      updateSeq: '100-seq',
      admittedAt: '2026-09-06T10:00:00.000Z',
    });

    const grant = writeGrantRepo.issueGrant({
      remoteFingerprint,
      vaultRoot: vaultDir,
      settingsHash: 'hash-abc',
      commonlibVersion: '0.1.21',
      bootstrapGeneration: 'gen-1',
    });

    checkpointRepo.saveCheckpoint({
      remoteFingerprint,
      lastUpdateSeq: '100-seq',
      completedAt: '2026-09-06T10:05:00.000Z',
    });

    provRepo.saveProvenance({
      path: 'notes/test.md',
      remoteRevision: '1-rev',
      contentSha256: 'sha-123',
      observedMtime: Date.now(),
      remoteFingerprint,
      reflectedAt: '2026-09-06T10:05:00.000Z',
    });

    quarRepo.saveQuarantine({
      originalPath: 'notes/conflict.md',
      quarantinePath: '.quarantine/conflict.md',
      remoteRevision: '2-rev',
      contentSha256: 'sha-quar',
      reason: 'DIVERGENT_DISPLACEMENT',
      quarantinedAt: '2026-09-06T10:06:00.000Z',
    });

    db.close();

    let jsonOutput = '';
    const exitCodeJson = await runStatusCommand({
      configPath,
      json: true,
      stdout: (msg) => {
        jsonOutput += msg;
      },
    });

    expect(exitCodeJson).toBe(EXIT_CODES.SUCCESS);
    const parsed = JSON.parse(jsonOutput.trim()) as StatusReport;

    expect(parsed.databaseExists).toBe(true);
    expect(parsed.admission.admitted).toBe(true);
    expect(parsed.admission.remoteFingerprint).toBe(remoteFingerprint);
    expect(parsed.admission.couchdbUrl).toContain('[REDACTED]');
    expect(parsed.admission.couchdbUrl).not.toContain('pass');
    expect(parsed.admission.databaseName).toBe('test_db');
    expect(parsed.admission.couchdbVersion).toBe('3.5.2');
    expect(parsed.admission.settingsHash).toBe('hash-abc');

    expect(parsed.writeGrant.active).toBe(true);
    expect(parsed.writeGrant.grantId).toBe(grant.grantId);
    expect(parsed.writeGrant.bootstrapGeneration).toBe('gen-1');

    expect(parsed.checkpoint.hasCheckpoint).toBe(true);
    expect(parsed.checkpoint.lastUpdateSeq).toBe('100-seq');

    expect(parsed.stats.trackedFilesCount).toBe(1);
    expect(parsed.stats.quarantineFilesCount).toBe(1);

    // Human output inspection
    let humanOutput = '';
    const exitCodeHuman = await runStatusCommand({
      configPath,
      json: false,
      stdout: (msg) => {
        humanOutput += msg;
      },
    });

    expect(exitCodeHuman).toBe(EXIT_CODES.SUCCESS);
    expect(humanOutput).toContain('OBSIDIAN LIVESYNC VAULT STATUS: [SUCCESS]');
    expect(humanOutput).toContain('State Database:           Present');
    expect(humanOutput).toContain('ADMITTED');
    expect(humanOutput).toContain(remoteFingerprint);
    expect(humanOutput).toContain('ACTIVE');
    expect(humanOutput).toContain(grant.grantId);
    expect(humanOutput).toContain('100-seq');
    expect(humanOutput).toContain('Tracked Files:          1');
    expect(humanOutput).toContain('Quarantined Files:      1');
  });

  it('inspects database with no admission record but active grant', async () => {
    const db = openDatabase(stateDbPath);
    const writeGrantRepo = new WriteGrantRepo(db);

    const grant = writeGrantRepo.issueGrant({
      remoteFingerprint: 'fp-custom',
      vaultRoot: vaultDir,
      settingsHash: 'hash-custom',
      commonlibVersion: '0.1.21',
      bootstrapGeneration: 'gen-custom',
    });
    db.close();

    let jsonOutput = '';
    const exitCode = await runStatusCommand({
      configPath,
      json: true,
      stdout: (msg) => {
        jsonOutput += msg;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.SUCCESS);
    const parsed = JSON.parse(jsonOutput.trim()) as StatusReport;
    expect(parsed.databaseExists).toBe(true);
    expect(parsed.admission.admitted).toBe(false);
    expect(parsed.writeGrant.active).toBe(true);
    expect(parsed.writeGrant.grantId).toBe(grant.grantId);
    expect(parsed.checkpoint.hasCheckpoint).toBe(false);
  });

  it('formats human and JSON reports via standalone formatters correctly', () => {
    const report: StatusReport = {
      type: 'status_report',
      outcome: OutcomeCategory.SUCCESS,
      vaultPath: '/path/to/vault',
      statePath: '/path/to/state.db',
      databaseExists: false,
      admission: { admitted: false },
      writeGrant: { active: false },
      checkpoint: { hasCheckpoint: false },
      stats: { trackedFilesCount: 0, quarantineFilesCount: 0 },
    };

    const human = formatStatusHuman(report);
    expect(human).toContain('OBSIDIAN LIVESYNC VAULT STATUS: [SUCCESS]');
    expect(human).toContain('Not found (Clean/Unconfigured)');
    expect(human).toContain('NOT ADMITTED');
    expect(human).toContain('INACTIVE / NOT ARMED');
    expect(human).toContain('Status:                 NONE');

    const json = formatStatusJson(report);
    const parsed = JSON.parse(json.trim());
    expect(parsed.type).toBe('status_report');
    expect(parsed.vaultPath).toBe('/path/to/vault');
  });

  it('routes status command via main CLI entrypoint correctly', async () => {
    const { main } = await import('../../src/cli/index.js');

    // Missing config
    const errCode = await main(['status']);
    expect(errCode).toBe(EXIT_CODES.CONFIG_ERROR);

    // Valid config
    const originalWrite = process.stdout.write;
    try {
      let stdout = '';
      process.stdout.write = ((chunk: any) => {
        stdout += String(chunk);
        return true;
      }) as any;

      const code = await main(['status', '-c', configPath]);
      expect(code).toBe(EXIT_CODES.SUCCESS);
      expect(stdout).toContain('OBSIDIAN LIVESYNC VAULT STATUS');
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
