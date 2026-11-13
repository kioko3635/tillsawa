import { loadConfig } from './config/env.js';
import { createSystemPool, createTenantPool } from './database/pool.js';
import { createApp } from './http/app.js';
import { startNetworkSync } from './modules/network/service.js';

const config = loadConfig();
const pool = createTenantPool(config);
const systemPool = createSystemPool(config);
const app = createApp({ config, pool, systemPool });
const stopNetworkSync=startNetworkSync(systemPool,config);

const server = app.listen(config.apiPort, config.apiHost, () => {
  console.log(`API listening on http://localhost:${config.apiPort}/api/v1`);
});

async function shutdown(signal: string): Promise<void> {
  stopNetworkSync();
  console.log(`Received ${signal}; shutting down API`);
  server.close(async () => {
    await Promise.allSettled([pool.end(), systemPool.end()]);
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
