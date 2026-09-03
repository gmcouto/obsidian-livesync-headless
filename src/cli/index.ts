import { parseArgs } from 'node:util';
import { logger } from '../diagnostics/logger.js';
import { EXIT_CODES } from '../diagnostics/outcomes.js';

export interface CliOptions {
  config?: string;
  json: boolean;
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

Options:
  -c, --config <path>         Path to YAML configuration file
      --json                  Output structured JSON Lines report
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

    // In this walking skeleton tracer, if inspect or config is given without implementation:
    if (!parsed.options.config && parsed.command === 'inspect') {
      logger.error('Missing required configuration file (--config <path>)');
      return EXIT_CODES.CONFIG_ERROR;
    }

    return EXIT_CODES.SUCCESS;
  } catch (error) {
    logger.error('CLI execution error', { error: String(error) });
    return EXIT_CODES.CONFIG_ERROR;
  }
}

// Direct execution entrypoint
if (process.argv[1] && (process.argv[1].endsWith('/cli/index.js') || process.argv[1].endsWith('/cli/index.ts'))) {
  main().then((exitCode) => {
    process.exit(exitCode);
  });
}
