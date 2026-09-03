import { describe, it, expect, vi } from 'vitest';
import { parseCliArgs, main, VERSION, CLI_HELP } from '../../src/cli/index.js';
import { EXIT_CODES, OutcomeCategory } from '../../src/diagnostics/outcomes.js';
import { Logger } from '../../src/diagnostics/logger.js';

describe('Walking Skeleton Smoke Tests', () => {
  it('exports expected outcome categories and exit codes', () => {
    expect(EXIT_CODES.SUCCESS).toBe(0);
    expect(EXIT_CODES.CONFIG_ERROR).toBe(1);
    expect(EXIT_CODES.AUTHENTICATION_ERROR).toBe(2);
    expect(EXIT_CODES.INCOMPATIBLE).toBe(3);
    expect(EXIT_CODES.NOT_FOUND).toBe(4);
    expect(EXIT_CODES.TRANSIENT_OUTAGE).toBe(5);
    expect(EXIT_CODES.MUTATION_VIOLATION).toBe(6);
    expect(EXIT_CODES.CORRUPTION).toBe(7);

    const categories: OutcomeCategory[] = [
      'SUCCESS',
      'CONFIG_ERROR',
      'AUTHENTICATION_ERROR',
      'INCOMPATIBLE',
      'NOT_FOUND',
      'TRANSIENT_OUTAGE',
      'MUTATION_VIOLATION',
      'CORRUPTION',
    ];
    expect(categories.length).toBe(8);
  });

  it('parses CLI arguments correctly', () => {
    const parsed1 = parseCliArgs(['--config', 'config.yaml', '--json']);
    expect(parsed1.options.config).toBe('config.yaml');
    expect(parsed1.options.json).toBe(true);
    expect(parsed1.options.help).toBe(false);

    const parsed2 = parseCliArgs(['inspect', '-c', 'my-vault.yaml']);
    expect(parsed2.command).toBe('inspect');
    expect(parsed2.options.config).toBe('my-vault.yaml');

    const parsed3 = parseCliArgs(['--version']);
    expect(parsed3.options.version).toBe(true);

    const parsed4 = parseCliArgs(['--help']);
    expect(parsed4.options.help).toBe(true);
  });

  it('outputs help text when --help is supplied', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await main(['--help']);
    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stdoutSpy).toHaveBeenCalledWith(CLI_HELP);
    stdoutSpy.mockRestore();
  });

  it('outputs version text when --version is supplied', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await main(['--version']);
    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stdoutSpy).toHaveBeenCalledWith(`obsidian-livesync-headless v${VERSION}\n`);
    stdoutSpy.mockRestore();
  });

  it('emits structured JSON Lines logs to destination', () => {
    const lines: string[] = [];
    const testLogger = new Logger('debug');
    testLogger.setDestination((line) => lines.push(line));

    testLogger.info('Testing info message', { count: 42 });
    testLogger.debug('Testing debug message', { detail: 'tracer' });

    expect(lines.length).toBe(2);

    const entry1 = JSON.parse(lines[0]);
    expect(entry1.level).toBe('info');
    expect(entry1.message).toBe('Testing info message');
    expect(entry1.count).toBe(42);
    expect(typeof entry1.timestamp).toBe('string');

    const entry2 = JSON.parse(lines[1]);
    expect(entry2.level).toBe('debug');
    expect(entry2.message).toBe('Testing debug message');
    expect(entry2.detail).toBe('tracer');
  });

  it('respects logger minimum log level filtering', () => {
    const lines: string[] = [];
    const testLogger = new Logger('warn');
    testLogger.setDestination((line) => lines.push(line));

    testLogger.debug('Should not appear');
    testLogger.info('Should not appear');
    testLogger.warn('Warning message');
    testLogger.error('Error message');

    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).level).toBe('warn');
    expect(JSON.parse(lines[1]).level).toBe('error');
  });
});
