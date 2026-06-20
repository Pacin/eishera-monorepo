// Centralized, validated environment access. Env is loaded by the run scripts
// (dotenv-cli reads the repo-root .env), so by the time this module runs the
// values are already on process.env. Fail fast if a required var is missing.

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// JWT secret is optional at module load (seed/migrate/demo scripts don't need
// it); the HTTP server warns when the insecure dev fallback is in use.
const DEV_JWT_SECRET = 'dev-insecure-secret-change-me';

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const env = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.PORT ?? 4000),
  nodeEnv,
  // Auth
  jwtSecret: process.env.JWT_SECRET ?? DEV_JWT_SECRET,
  jwtSecretIsDevDefault: !process.env.JWT_SECRET,
  cookieSecret: process.env.COOKIE_SECRET ?? process.env.JWT_SECRET ?? DEV_JWT_SECRET,
  // Secure cookies require HTTPS; default on in production, override with COOKIE_SECURE.
  cookieSecure:
    (process.env.COOKIE_SECURE ?? (nodeEnv === 'production' ? 'true' : 'false')) === 'true',
  accessTtl: process.env.ACCESS_TTL ?? '15m',
  refreshTtlDays: Number(process.env.REFRESH_TTL_DAYS ?? 30),
} as const;
