export const DEFAULT_ENVIRONMENT = 'PRODUCTION';

export const DATABASES = Object.freeze({
  DEV: Object.freeze({
    url: 'https://ayiuyhslruxjvjxyanpa.supabase.co',
    publishableKey: 'sb_publishable_W6gjBO30oSDasYmZymxk1g_e1-UCgA6',
  }),
  PRODUCTION: Object.freeze({
    url: 'https://gcnkgouwxjctanmnxvhn.supabase.co',
    publishableKey: 'sb_publishable_tViZ3k1xjZf8l6vvTfvkxg_yQUEpTz6',
  }),
});

const params = new URLSearchParams(globalThis.location?.search || '');
const environment = (params.has('env')
  ? params.get('env').trim()
  : params.get('dev') === '1' ? 'DEV' : DEFAULT_ENVIRONMENT).toUpperCase();
if (!Object.hasOwn(DATABASES, environment)) {
  throw new Error(`Unknown database environment "${environment}". Use DEV or PRODUCTION.`);
}

export const config = Object.freeze({
  environment,
  supabase: DATABASES[environment],
});

export function pageUrl(page, parameters = {}) {
  const query = new URLSearchParams(parameters);
  query.set('env', config.environment.toLowerCase());
  return `${page}?${query.toString()}`;
}
