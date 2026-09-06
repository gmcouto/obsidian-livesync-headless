#!/usr/bin/env node

// Intercept and suppress experimental SQLite notices in standalone mode
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) {
    return;
  }
});

import { main } from './cli/index.js';

main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Fatal execution error: ${message}\n`);
    process.exit(1);
  });
