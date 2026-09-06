import { parseArgs } from 'node:util';
import { logger } from '../diagnostics/logger.js';
import { EXIT_CODES } from '../diagnostics/outcomes.js';
import { defaultRedactor } from '../security/redaction.js';
import { runInspectCommand } from './commands/inspect.js';
import { runPullCommand } from './commands/pull.js';
import { runArmCommand } from './commands/arm.js';
import { runSyncCommand } from './commands/sync.js';

export interface CliOptions {
  config?: string;
  json: boolean;
  dryRun: boolean;
  revoke: boolean;
  help: boolean;
  version: boolean;
}

export interface CliParsed {
  command?: string;
  options: CliOptions;
}

export const CLI_HELP = `obsidian-livesync-headless [command] [options]

Commands:
  inspect                     Safely inspect and negotiate compatibility with CouchDB
  pull                        Materialize verified remote LiveSync files into a vault
  arm                         Issue or revoke durable 5-tuple write grant for vault & remote
  sync                        Bidirectional synchronization with chunk-first push and guard

Options:
  -c, --config <path>         Path to YAML configuration file
      --json                  Output structured JSON Lines report
      --dry-run               Preview synchronization actions without mutation
      --revoke                Revoke active write grant for the vault (arm command)
  -h, --help                  Show help and usage information
  -v, --version               Show version information
`;

export const VERSION = '0.1.0';

export function parseCliArgs(args: string[] = process.argv.slice(2)): { command?: string; options: CliOptions } {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: {
        type: 'string',
        short: 'c',
      },
      json: {
        type: 'boolean',
        default: false,
      },
      'dry-run': {
        type: 'boolean',
        default: false,
      },
      revoke: {
        type: 'boolean',
        default: false,
      },
      help: {
        type: 'boolean',
        short: 'h',
        default: false,
      },
      version: {
        type: 'boolean',
        short: 'v',
        default: false,
      },
    },
    allowPositionals: true,
  });

  return {
    command: positionals[0],
    options: {
      config: values.config,
      json: values.json ?? false,
      dryRun: values['dry-run'] ?? false,
      revoke: values.revoke ?? false,
      help: values.help ?? false,
      version: values.version ?? false,
    },
  };
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseCliArgs(args);

    if (parsed.options.version) {
      process.stdout.write(`obsidian-livesync-headless v${VERSION}\n`);
      return EXIT_CODES.SUCCESS;
    }

    if (parsed.options.help || (args.length === 0 && !parsed.command && !parsed.options.config)) {
      process.stdout.write(CLI_HELP);
      return EXIT_CODES.SUCCESS;
    }

    logger.debug('CLI arguments parsed', {
      command: parsed.command,
      hasConfig: Boolean(parsed.options.config),
      json: parsed.options.json,
    });

    if (parsed.command === 'arm') {
      if (!parsed.options.config) {
        logger.error('Missing required configuration file (--config <path>)');
        return EXIT_CODES.CONFIG_ERROR;
      }

      return await runArmCommand({
        configPath: parsed.options.config,
        json: parsed.options.json,
        revoke: parsed.options.revoke,
      });
    }

    if (parsed.command === 'sync') {
      if (!parsed.options.config) {
        logger.error('Missing required configuration file (--config <path>)');
        return EXIT_CODES.CONFIG_ERROR;
      }

      return await runSyncCommand({
        configPath: parsed.options.config,
        dryRun: parsed.options.dryRun,
        json: parsed.options.json,
      });
    }

    const isPull = parsed.command === 'pull';
    if (isPull) {
      if (!parsed.options.config) {
        logger.error('Missing required configuration file (--config <path>)');
        return EXIT_CODES.CONFIG_ERROR;
      }

      return await runPullCommand({
        configPath: parsed.options.config,
        json: parsed.options.json,
        dryRun: parsed.options.dryRun,
      });
    }

    const isInspect = !parsed.command || parsed.command === 'inspect';
    if (isInspect) {
      if (!parsed.options.config) {
        logger.error('Missing required configuration file (--config <path>)');
        return EXIT_CODES.CONFIG_ERROR;
      }

      return await runInspectCommand({
        configPath: parsed.options.config,
        json: parsed.options.json,
      });
    }

    logger.error(`Unknown command '${parsed.command}'`);
    process.stdout.write(CLI_HELP);
    return EXIT_CODES.CONFIG_ERROR;
  } catch (error) {
    const sanitizedError = defaultRedactor.redactError(error as Error);
    logger.error('Unhandled CLI execution error', { error: sanitizedError.message });
    return EXIT_CODES.CONFIG_ERROR;
  }
}

// Direct execution entrypoint
if (process.argv[1] && (process.argv[1].endsWith('/cli/index.js') || process.argv[1].endsWith('/cli/index.ts'))) {
  main().then((exitCode) => {
    process.exit(exitCode);
  });
}

