import {loadConfig} from '../../apps/api/dist/config/env.js';
import {createSystemPool} from '../../apps/api/dist/database/pool.js';
import {applyMigrations} from '../../apps/api/dist/database/migrator.js';
const pool=createSystemPool(loadConfig());
console.log('Applying database migrations...');
try {await applyMigrations(pool);} finally {await pool.end();}
console.log('Database ready; starting TillSawa.');
await import('../../apps/api/dist/index.js');
