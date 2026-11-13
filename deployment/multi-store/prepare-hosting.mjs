import {randomBytes,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const domain=process.argv[2];
const cloud=process.argv[3] === '--cloud';
if (process.argv[3] && !cloud) throw new Error('Unknown option');
if(!domain || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) throw new Error('Usage: node prepare-hosting.mjs dashboard.your-domain.co.ke');
const values={POS_DOMAIN:domain,POS_DB_ADMIN_PASSWORD:randomBytes(32).toString('hex'),POS_APP_PASSWORD:randomBytes(32).toString('hex'),POS_SYSTEM_PASSWORD:randomBytes(32).toString('hex'),ACCESS_TOKEN_SECRET:randomBytes(32).toString('hex'),REFRESH_TOKEN_PEPPER:randomBytes(32).toString('hex'),CSRF_SECRET:randomBytes(32).toString('hex')};
if (cloud) Object.assign(values, {
  POS_CLOUD_SETUP_KEY: randomBytes(32).toString('hex'),
  POS_INSTALLATION_ID: randomUUID(),
  POS_MACHINE_ID: randomBytes(32).toString('hex'),
  POS_MANAGEMENT_PASSWORD: randomBytes(32).toString('hex')
});
await writeFile(join(dirname(fileURLToPath(import.meta.url)),cloud ? '.env.cloud' : '.env'),Object.entries(values).map(([key,value])=>`${key}=${value}`).join('\n')+'\n',{flag:'wx',mode:0o600});
console.log('Hosting .env created with independent random secrets. Keep it private and back it up. Existing files are never overwritten.');
