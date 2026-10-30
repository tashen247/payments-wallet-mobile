/**
 * DATABASE_URL wins; otherwise build one from DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME, which is
 * how ECS injects the RDS-generated secret.
 */
export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.DB_HOST) {
    const user = encodeURIComponent(env.DB_USER ?? 'wallet');
    const pass = encodeURIComponent(env.DB_PASSWORD ?? '');
    const ssl = env.NODE_ENV === 'production' ? '?sslmode=no-verify' : '';
    return `postgres://${user}:${pass}@${env.DB_HOST}:${env.DB_PORT ?? 5432}/${env.DB_NAME ?? 'wallet'}${ssl}`;
  }
  return 'postgres://wallet:wallet@localhost:5432/wallet';
}
