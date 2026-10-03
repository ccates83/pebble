#!/usr/bin/env node
// node:sqlite is still flagged experimental; the warning is noise for a user
// running a dashboard, so it is suppressed here rather than printed on startup.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  console.warn(`${warning.name}: ${warning.message}`);
});

const { main } = await import('../dist/index.js');
await main();
