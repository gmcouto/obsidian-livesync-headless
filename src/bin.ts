#!/usr/bin/env node

// Intercept and suppress experimental SQLite notices in standalone mode
const originalEmitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...args: any[]) => {
  if (typeof warning === 'string' && warning.includes('SQLite')) {
    return;
  }
  if (
    typeof warning === 'object' &&
    warning !== null &&
    'message' in warning &&
    typeof (warning as { message?: unknown }).message === 'string' &&
    (warning as { message: string }).message.includes('SQLite')
  ) {
    return;
  }
  return (originalEmitWarning as any).call(process, warning, ...args);
}) as typeof process.emitWarning;

process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) {
    return;
  }
});

async function run(): Promise<void> {
  const { main } = await import('./cli/index.js');
  const exitCode = await main();
  process.exit(exitCode);
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal execution error: ${message}\n`);
  process.exit(1);
});
