import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    if (value === undefined) return undefined;
    return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default('127.0.0.1'),
  SERVE_WEB: booleanFromEnv.default('false'),
  POS_SHARED_SERVER: booleanFromEnv.default('false'),
  POS_CLOUD: booleanFromEnv.default('false'),
  POS_CLOUD_SETUP_KEY: z.union([z.literal(''), z.string().regex(/^[a-f0-9]{64}$/)]).optional(),
  MULTI_STORE_HUB: booleanFromEnv.default('false'),
  PAYMENT_TEST_MODE: booleanFromEnv.default('false'),
  POS_LICENSE_REQUIRED: booleanFromEnv.default('false'),
  POS_MANAGEMENT_PASSWORD: z.union([z.literal(''), z.string().regex(/^[a-f0-9]{64}$/)]).optional(),
  POS_INSTALLATION_ID: z.string().uuid().optional(),
  POS_MACHINE_ID: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  PESAPAL_TERMINAL_API_KEY: z.string().optional(),
  PESAPAL_ORGANIZATION_ID: z.union([z.literal(''), z.string().uuid()]).optional(),
  DARAJA_CONSUMER_KEY: z.string().optional(),
  DARAJA_CONSUMER_SECRET: z.string().optional(),
  DARAJA_PASSKEY: z.string().optional(),
  DARAJA_SHORTCODE: z.union([z.literal(''), z.string().regex(/^\d{5,7}$/)]).optional(),
  DARAJA_CALLBACK_URL: z.union([z.literal(''), z.string().url()]).optional(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1).optional(),
  TEST_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_SYSTEM_URL: z.string().min(1).optional(),
  TEST_DATABASE_SYSTEM_URL: z.string().min(1).optional(),
  DATABASE_SSL: booleanFromEnv.default('false'),
  ACCESS_TOKEN_SECRET: z.string().min(32).default('development-access-secret-change-me-32'),
  REFRESH_TOKEN_PEPPER: z.string().min(32).default('development-refresh-pepper-change-me-32'),
  CSRF_SECRET: z.string().min(32).default('development-csrf-secret-change-me-32'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().max(90).default(30),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().max(240).default(30),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(14).default(12),
  COOKIE_SECURE: booleanFromEnv,
  COOKIE_DOMAIN: z.string().optional(),
  TRUST_PROXY: booleanFromEnv.default('false'),
  EXPOSE_DEV_TOKENS: booleanFromEnv.default('false'),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600)
}).superRefine((env, context) => {
  if (env.POS_LICENSE_REQUIRED && (!env.POS_INSTALLATION_ID || !env.POS_MACHINE_ID)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Installed licensing requires installation and machine identity.' });
  if (env.NODE_ENV !== 'production') return;
  const secrets = [env.ACCESS_TOKEN_SECRET, env.REFRESH_TOKEN_PEPPER, env.CSRF_SECRET];
  for (const name of ['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_PEPPER', 'CSRF_SECRET'] as const) {
    if (/development|change.?me|replace.?with/i.test(env[name])) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'Set a randomly generated production secret.' });
    }
  }
  if (new Set(secrets).size !== secrets.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Production secrets must be distinct.' });
  if (env.EXPOSE_DEV_TOKENS) context.addIssue({ code: z.ZodIssueCode.custom, path: ['EXPOSE_DEV_TOKENS'], message: 'Development tokens must be disabled in production.' });
});

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  apiPort: number;
  apiHost: string;
  serveWeb: boolean;
  sharedServer?: boolean;
  multiStoreHub?: boolean;
  cloud?: boolean;
  managementPassword?: string;
  cloudSetupKey?: string;
  corsOrigins: string[];
  databaseUrl: string | undefined;
  testDatabaseUrl: string | undefined;
  databaseSystemUrl: string | undefined;
  testDatabaseSystemUrl: string | undefined;
  databaseSsl: boolean;
  accessTokenSecret: string;
  refreshTokenPepper: string;
  csrfSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  passwordResetTtlMinutes: number;
  bcryptRounds: number;
  cookieSecure: boolean;
  cookieDomain: string | undefined;
  trustProxy: boolean;
  exposeDevTokens: boolean;
  authRateLimitMax: number;
  apiRateLimitMax: number;
  paymentTestMode: boolean;
  licensing?: { installationId: string; machineId: string; publicKeyPath?: string };
  pesapalTerminalKey?: string | undefined;
  pesapalOrganizationId?: string | undefined;
  darajaConsumerKey?: string | undefined;
  darajaConsumerSecret?: string | undefined;
  darajaPasskey?: string | undefined;
  darajaShortcode?: string | undefined;
  darajaCallbackUrl?: string | undefined;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  if (parsed.POS_CLOUD && (parsed.MULTI_STORE_HUB || parsed.POS_SHARED_SERVER)) throw new Error('Cloud checkout, local shared server and reporting hub are separate deployment modes.');
  return {
    cloud: parsed.POS_CLOUD ?? false,
    ...(parsed.POS_MANAGEMENT_PASSWORD ? { managementPassword: parsed.POS_MANAGEMENT_PASSWORD } : {}),
    ...(parsed.POS_CLOUD_SETUP_KEY ? { cloudSetupKey: parsed.POS_CLOUD_SETUP_KEY } : {}),
    nodeEnv: parsed.NODE_ENV,
    apiPort: parsed.API_PORT,
    apiHost: parsed.API_HOST,
    paymentTestMode: parsed.PAYMENT_TEST_MODE ?? false,
    ...(parsed.POS_LICENSE_REQUIRED ? { licensing: { installationId: parsed.POS_INSTALLATION_ID!, machineId: parsed.POS_MACHINE_ID! } } : {}),
    pesapalTerminalKey: parsed.PESAPAL_TERMINAL_API_KEY,
    pesapalOrganizationId: parsed.PESAPAL_ORGANIZATION_ID,
    darajaConsumerKey: parsed.DARAJA_CONSUMER_KEY,
    darajaConsumerSecret: parsed.DARAJA_CONSUMER_SECRET,
    darajaPasskey: parsed.DARAJA_PASSKEY,
    darajaShortcode: parsed.DARAJA_SHORTCODE,
    darajaCallbackUrl: parsed.DARAJA_CALLBACK_URL,
    serveWeb: parsed.SERVE_WEB ?? false,
    sharedServer: parsed.POS_SHARED_SERVER ?? false,
    multiStoreHub: parsed.MULTI_STORE_HUB ?? false,
    corsOrigins: parsed.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean),
    databaseUrl: parsed.DATABASE_URL,
    testDatabaseUrl: parsed.TEST_DATABASE_URL,
    databaseSystemUrl: parsed.DATABASE_SYSTEM_URL,
    testDatabaseSystemUrl: parsed.TEST_DATABASE_SYSTEM_URL,
    databaseSsl: parsed.DATABASE_SSL ?? false,
    accessTokenSecret: parsed.ACCESS_TOKEN_SECRET,
    refreshTokenPepper: parsed.REFRESH_TOKEN_PEPPER,
    csrfSecret: parsed.CSRF_SECRET,
    accessTokenTtlSeconds: parsed.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: parsed.REFRESH_TOKEN_TTL_DAYS,
    passwordResetTtlMinutes: parsed.PASSWORD_RESET_TTL_MINUTES,
    bcryptRounds: parsed.BCRYPT_ROUNDS,
    cookieSecure: parsed.COOKIE_SECURE ?? parsed.NODE_ENV === 'production',
    cookieDomain: parsed.COOKIE_DOMAIN,
    trustProxy: parsed.TRUST_PROXY ?? false,
    exposeDevTokens: parsed.EXPOSE_DEV_TOKENS ?? false,
    authRateLimitMax: parsed.AUTH_RATE_LIMIT_MAX,
    apiRateLimitMax: parsed.API_RATE_LIMIT_MAX
  };
}
