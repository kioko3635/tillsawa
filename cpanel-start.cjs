'use strict';

// Set API_PORT explicitly if your hosting panel does not supply a numeric PORT.
if (process.env.API_PORT === undefined && process.env.PORT !== undefined) {
  if (!/^\d+$/.test(process.env.PORT) || Number(process.env.PORT) < 1 || Number(process.env.PORT) > 65535) {
    console.error('TillSawa requires a numeric API_PORT. Ask your host how its Node.js app listener is assigned.');
    process.exit(1);
  }
  process.env.API_PORT = process.env.PORT;
}
import('./deployment/multi-store/hub-entry.mjs').catch(error => {
  console.error('TillSawa startup failed:', error.code ?? error.name);
  process.exitCode = 1;
});
