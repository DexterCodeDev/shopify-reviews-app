import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generatedDir = join(root, '.wrangler', 'generated');
const generatedWranglerPath = join(generatedDir, 'wrangler.jsonc');
const generatedShopifyPath = join(generatedDir, 'shopify.app.toml');
const generatedManifestPath = join(generatedDir, 'resources.json');
const generatedSecretsPath = join(generatedDir, 'secrets.json');
const deployRedirectDir = join(root, '.wrangler', 'deploy');
const deployRedirectPath = join(deployRedirectDir, 'config.json');
const flags = new Set(process.argv.slice(2));
const shouldDeploy = flags.has('--deploy');
const migrateOnly = flags.has('--migrate-only');
const writeDeployRedirectFile = flags.has('--write-deploy-redirect');

class CloudflareApiError extends Error {
  constructor(message, status, details = []) {
    super(message);
    this.name = 'CloudflareApiError';
    this.status = status;
    this.details = details;
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name) {
  return process.env[name]?.trim() || '';
}

function slug(value, maxLength = 63) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  if (normalized.length >= 3) return normalized;
  return `${normalized || 'app'}-cf`.slice(0, maxLength);
}

function validateHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`);
  return url.toString().replace(/\/$/, '');
}

function resolveShopifyConfiguration() {
  const apiKey = optional('SHOPIFY_API_KEY');
  const apiSecret = optional('SHOPIFY_API_SECRET');
  if (Boolean(apiKey) !== Boolean(apiSecret)) {
    throw new Error('SHOPIFY_API_KEY and SHOPIFY_API_SECRET must be provided together, or both omitted for setup mode.');
  }
  return { apiKey, apiSecret, configured: Boolean(apiKey && apiSecret) };
}

function validateConfiguredSecrets(shopify) {
  if (Boolean(shopify.apiKey) !== Boolean(shopify.apiSecret)) {
    throw new Error('SHOPIFY_API_KEY and SHOPIFY_API_SECRET must be provided together.');
  }
  const encryptionKey = optional('APP_ENCRYPTION_KEY');
  if (encryptionKey && encryptionKey.length < 32) {
    throw new Error('APP_ENCRYPTION_KEY must contain at least 32 characters.');
  }
}

async function cloudflareApi(path, { method = 'GET', body, headers = {} } = {}) {
  const accountId = required('CLOUDFLARE_ACCOUNT_ID');
  const token = required('CLOUDFLARE_API_TOKEN');
  const apiBase = optional('CLOUDFLARE_API_BASE_URL') || 'https://api.cloudflare.com/client/v4';
  const response = await fetch(`${apiBase.replace(/\/$/, '')}/accounts/${accountId}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { errors: [{ message: text || `HTTP ${response.status}` }] };
  }

  if (!response.ok || payload.success === false) {
    const details = [...(payload.errors || []), ...(payload.messages || [])]
      .map((item) => (typeof item === 'string' ? item : item?.message))
      .filter(Boolean);
    throw new CloudflareApiError(
      details.join('; ') || `Cloudflare API request failed: ${method} ${path}`,
      response.status,
      details,
    );
  }
  return payload.result;
}

async function getOrCreateD1(name) {
  const query = new URLSearchParams({ name, per_page: '100' });
  const databases = await cloudflareApi(`/d1/database?${query}`);
  const existing = (Array.isArray(databases) ? databases : []).find((database) => database.name === name);
  if (existing?.uuid) {
    console.log(`✓ D1 ${name} already exists`);
    return existing;
  }

  console.log(`+ Creating D1 ${name}`);
  try {
    return await cloudflareApi('/d1/database', { method: 'POST', body: { name } });
  } catch (error) {
    if (!(error instanceof CloudflareApiError)) throw error;
    const retry = await cloudflareApi(`/d1/database?${query}`);
    const found = (Array.isArray(retry) ? retry : []).find((database) => database.name === name);
    if (found?.uuid) return found;
    throw error;
  }
}

async function getOrCreateR2(name) {
  const query = new URLSearchParams({ name_contains: name, per_page: '1000' });
  const response = await cloudflareApi(`/r2/buckets?${query}`);
  const buckets = Array.isArray(response?.buckets) ? response.buckets : [];
  const existing = buckets.find((bucket) => bucket.name === name);
  if (existing) {
    console.log(`✓ R2 ${name} already exists`);
    return existing;
  }

  console.log(`+ Creating R2 ${name}`);
  try {
    return await cloudflareApi('/r2/buckets', { method: 'POST', body: { name } });
  } catch (error) {
    if (!(error instanceof CloudflareApiError)) throw error;
    const retry = await cloudflareApi(`/r2/buckets?${query}`);
    const found = (retry?.buckets || []).find((bucket) => bucket.name === name);
    if (found) return found;
    throw error;
  }
}

function requestedQueueRetentionSeconds() {
  return Math.max(60, Math.min(1_209_600, Number(optional('QUEUE_MESSAGE_RETENTION_SECONDS') || 1_209_600)));
}

async function updateQueueRetention(queue, requestedSeconds) {
  if (!queue?.queue_id) return queue;
  const current = Number(queue.settings?.message_retention_period || 0);
  if (current === requestedSeconds) return queue;
  const apply = (seconds) => cloudflareApi(`/queues/${queue.queue_id}`, {
    method: 'PATCH',
    body: { settings: { message_retention_period: seconds } },
  });
  try {
    const updated = await apply(requestedSeconds);
    console.log(`✓ Queue ${queue.queue_name} retention set to ${requestedSeconds}s`);
    return updated || queue;
  } catch (error) {
    if (!(error instanceof CloudflareApiError) || requestedSeconds <= 86_400) throw error;
    console.warn(`! Queue ${queue.queue_name} could not use ${requestedSeconds}s retention; retrying with 86400s.`);
    return (await apply(86_400)) || queue;
  }
}

async function createQueueWithRetention(name, requestedSeconds) {
  const create = (seconds) => cloudflareApi('/queues', {
    method: 'POST',
    body: { queue_name: name, settings: { message_retention_period: seconds } },
  });
  try {
    return await create(requestedSeconds);
  } catch (error) {
    if (!(error instanceof CloudflareApiError) || requestedSeconds <= 86_400) throw error;
    console.warn(`! Queue ${name} could not use ${requestedSeconds}s retention; creating it with 86400s.`);
    return create(86_400);
  }
}

async function getOrCreateQueue(name) {
  const retentionSeconds = requestedQueueRetentionSeconds();
  const queues = await cloudflareApi('/queues');
  const existing = (Array.isArray(queues) ? queues : []).find((queue) => queue.queue_name === name);
  if (existing) {
    console.log(`✓ Queue ${name} already exists`);
    return updateQueueRetention(existing, retentionSeconds);
  }

  console.log(`+ Creating Queue ${name}`);
  try {
    return await createQueueWithRetention(name, retentionSeconds);
  } catch (error) {
    if (!(error instanceof CloudflareApiError)) throw error;
    const retry = await cloudflareApi('/queues');
    const found = (Array.isArray(retry) ? retry : []).find((queue) => queue.queue_name === name);
    if (found) return updateQueueRetention(found, retentionSeconds);
    throw error;
  }
}

async function resolveApplicationUrl(workerName) {
  const configured = optional('APPLICATION_URL');
  if (configured) return validateHttpsUrl(configured, 'APPLICATION_URL');

  let subdomain = '';
  try {
    const result = await cloudflareApi('/workers/subdomain');
    subdomain = result?.subdomain || '';
  } catch (error) {
    if (!(error instanceof CloudflareApiError)) throw error;
  }

  if (!subdomain) {
    const accountId = required('CLOUDFLARE_ACCOUNT_ID');
    const owner = slug(optional('GITHUB_REPOSITORY_OWNER') || workerName, 45);
    const suffix = accountId.slice(0, 12).toLowerCase();
    const automaticCandidate = `${owner.slice(0, Math.max(3, 62 - suffix.length))}-${suffix}`;
    const candidate = slug(optional('WORKERS_SUBDOMAIN') || automaticCandidate);
    console.log(`+ Creating Workers subdomain ${candidate}.workers.dev`);
    const result = await cloudflareApi('/workers/subdomain', {
      method: 'PUT',
      body: { subdomain: candidate },
    });
    subdomain = result?.subdomain || candidate;
  } else {
    console.log(`✓ Workers subdomain ${subdomain}.workers.dev already exists`);
  }

  return `https://${workerName}.${subdomain}.workers.dev`;
}

function renderWranglerConfig({ accountId, workerName, applicationUrl, publicCdnBase, database, bucketName, eventQueueName, deadLetterQueueName, shopify }) {
  const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
  const generatedPath = (pathFromRoot) => relative(generatedDir, join(root, pathFromRoot)).replaceAll('\\', '/');

  config.$schema = generatedPath('node_modules/wrangler/config-schema.json');
  config.main = generatedPath(config.main);
  delete config.build;
  delete config.secrets;

  config.name = workerName;
  config.account_id = accountId;
  config.vars = {
    ...config.vars,
    APP_ENV: 'production',
    APP_URL: applicationUrl,
    PUBLIC_CDN_BASE: publicCdnBase,
    SHOPIFY_API_VERSION: optional('SHOPIFY_API_VERSION') || config.vars.SHOPIFY_API_VERSION || '2026-07',
    SHOPIFY_SCOPES: optional('SHOPIFY_SCOPES') || config.vars.SHOPIFY_SCOPES || 'read_products,read_orders,read_customers',
    PROJECTION_CACHE_SECONDS: optional('PROJECTION_CACHE_SECONDS') || config.vars.PROJECTION_CACHE_SECONDS || '60',
  };
  delete config.vars.DEV_SHOP_DOMAIN;
  delete config.vars.DEV_ADMIN_TOKEN;

  for (const name of ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'APP_ENCRYPTION_KEY']) {
    if (optional(name)) delete config.vars[name];
  }
  if (optional('TURNSTILE_SECRET')) delete config.vars.TURNSTILE_SECRET;
  else delete config.vars.TURNSTILE_SECRET;

  config.d1_databases = [{
    binding: 'DB',
    database_name: database.name,
    database_id: database.uuid,
    migrations_dir: generatedPath('migrations'),
  }];
  config.r2_buckets = [{ binding: 'PROJECTIONS', bucket_name: bucketName }];
  config.queues = {
    producers: [{ binding: 'EVENTS', queue: eventQueueName }],
    consumers: [{
      queue: eventQueueName,
      max_batch_size: 20,
      max_batch_timeout: 5,
      max_retries: 5,
      dead_letter_queue: deadLetterQueueName,
    }],
  };

  writeFileSync(generatedWranglerPath, `${JSON.stringify(config, null, 2)}\n`);
}

function renderShopifyConfig({ clientId, applicationUrl }) {
  const sourcePath = join(root, 'shopify.app.toml');
  let toml = readFileSync(sourcePath, 'utf8');
  toml = toml
    .replace(/^# Replace the placeholders.*\n?/m, '# Generated values are injected during deployment.\n')
    .replace(/^client_id\s*=\s*"[^"]*"/m, `client_id = "${clientId}"`)
    .replace(/^application_url\s*=\s*"[^"]*"/m, `application_url = "${applicationUrl}"`)
    .replace(/"https:\/\/[^/"]+\/auth\/callback"/g, `"${applicationUrl}/auth/callback"`);
  writeFileSync(generatedShopifyPath, toml);
}

function writeDeployRedirect() {
  mkdirSync(deployRedirectDir, { recursive: true });
  writeFileSync(deployRedirectPath, `${JSON.stringify({ configPath: '../generated/wrangler.jsonc' }, null, 2)}\n`);
  console.log(`✓ Wrangler deploy redirected to ${generatedWranglerPath}`);
}

function runWrangler(args, { allowFailure = false, capture = false } = {}) {
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(command, ['wrangler', ...args], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0 && !allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`Wrangler command failed: wrangler ${args.join(' ')}${detail ? `\n${detail}` : ''}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function parseJsonOutput(output, fallback) {
  const trimmed = output.trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstArray = trimmed.indexOf('[');
    const firstObject = trimmed.indexOf('{');
    const first = [firstArray, firstObject].filter((index) => index >= 0).sort((a, b) => a - b)[0];
    if (first === undefined) return fallback;
    for (let end = trimmed.length; end > first; end -= 1) {
      try {
        return JSON.parse(trimmed.slice(first, end));
      } catch {
        // Trim trailing Wrangler output until the JSON can be parsed.
      }
    }
    return fallback;
  }
}

function getExistingSecretNames(workerName) {
  const result = runWrangler(
    ['secret', 'list', '--name', workerName, '--config', generatedWranglerPath, '--format', 'json'],
    { allowFailure: true, capture: true },
  );
  if (result.status !== 0) return new Set();
  const rows = parseJsonOutput(result.stdout, []);
  return new Set((Array.isArray(rows) ? rows : []).map((row) => row.name).filter(Boolean));
}

function buildSecrets(shopify) {
  const secrets = {};
  if (shopify.configured) {
    secrets.SHOPIFY_API_KEY = shopify.apiKey;
    secrets.SHOPIFY_API_SECRET = shopify.apiSecret;
  }
  if (optional('APP_ENCRYPTION_KEY')) secrets.APP_ENCRYPTION_KEY = optional('APP_ENCRYPTION_KEY');
  if (optional('TURNSTILE_SECRET')) secrets.TURNSTILE_SECRET = optional('TURNSTILE_SECRET');
  return secrets;
}

function removeSecretBackedPlaceholders(secretNames) {
  if (!secretNames.size) return;
  const config = JSON.parse(readFileSync(generatedWranglerPath, 'utf8'));
  let changed = false;
  for (const name of secretNames) {
    if (Object.hasOwn(config.vars || {}, name)) {
      delete config.vars[name];
      changed = true;
    }
  }
  if (changed) writeFileSync(generatedWranglerPath, `${JSON.stringify(config, null, 2)}\n`);
}

function applyMigrations() {
  console.log('Applying D1 migrations…');
  runWrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', generatedWranglerPath]);
}

function deployWorker(workerName, shopify) {
  const existingSecretNames = getExistingSecretNames(workerName);
  const secrets = buildSecrets(shopify);
  removeSecretBackedPlaceholders(new Set([...existingSecretNames, ...Object.keys(secrets)]));

  console.log('Deploying Worker, bindings, queue consumer, cron trigger, and Durable Object migration…');
  if (!Object.keys(secrets).length) {
    runWrangler(['deploy', '--config', generatedWranglerPath]);
    console.log('✓ Worker deployed in setup mode with normal-text placeholders for Shopify credentials and the encryption key.');
    return;
  }

  writeFileSync(generatedSecretsPath, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
  chmodSync(generatedSecretsPath, 0o600);
  try {
    runWrangler(['deploy', '--config', generatedWranglerPath, '--secrets-file', generatedSecretsPath]);
    console.log('✓ Environment-provided application values uploaded as encrypted Worker secrets.');
  } finally {
    rmSync(generatedSecretsPath, { force: true });
  }
}

function writeGitHubMetadata(manifest) {
  const outputPath = optional('GITHUB_OUTPUT');
  if (outputPath) {
    writeFileSync(outputPath, [
      `application_url=${manifest.application_url}`,
      `worker_name=${manifest.worker_name}`,
      `database=${manifest.d1.name}`,
      `r2_bucket=${manifest.r2_bucket}`,
      `event_queue=${manifest.queues.events}`,
      `dead_letter_queue=${manifest.queues.dead_letter}`,
      '',
    ].join('\n'), { flag: 'a' });
  }

  const summaryPath = optional('GITHUB_STEP_SUMMARY');
  if (summaryPath) {
    writeFileSync(summaryPath, [
      '## Reviews Cloud deployment',
      '',
      `- Worker: \`${manifest.worker_name}\``,
      `- URL: ${manifest.application_url}`,
      `- D1: \`${manifest.d1.name}\``,
      `- R2: \`${manifest.r2_bucket}\``,
      `- Queue: \`${manifest.queues.events}\``,
      `- DLQ: \`${manifest.queues.dead_letter}\``,
      '',
    ].join('\n'), { flag: 'a' });
  }
}

async function main() {
  mkdirSync(generatedDir, { recursive: true });
  const accountId = required('CLOUDFLARE_ACCOUNT_ID');
  required('CLOUDFLARE_API_TOKEN');

  const workerName = slug(optional('WORKER_NAME') || 'shopify-reviews-cloudflare');
  const resourcePrefix = slug(optional('RESOURCE_PREFIX') || 'shopify-reviews', 42);
  const shopify = resolveShopifyConfiguration();
  validateConfiguredSecrets(shopify);
  const applicationUrl = await resolveApplicationUrl(workerName);
  const publicCdnBase = optional('PUBLIC_CDN_BASE')
    ? validateHttpsUrl(optional('PUBLIC_CDN_BASE'), 'PUBLIC_CDN_BASE')
    : `${applicationUrl}/cdn`;

  const databaseName = optional('D1_DATABASE_NAME') || `${resourcePrefix}-db`;
  const bucketName = optional('R2_BUCKET_NAME') || `${resourcePrefix}-projections`;
  const eventQueueName = optional('EVENT_QUEUE_NAME') || `${resourcePrefix}-events`;
  const deadLetterQueueName = optional('EVENT_DLQ_NAME') || `${resourcePrefix}-events-dlq`;

  if (!shopify.configured) {
    console.warn('! Shopify credentials were not supplied through the build environment. Setup placeholders will be deployed as normal text.');
  }

  console.log(`Provisioning Cloudflare resources for ${workerName}…`);
  const database = await getOrCreateD1(databaseName);
  const bucket = await getOrCreateR2(bucketName);
  await Promise.all([getOrCreateQueue(eventQueueName), getOrCreateQueue(deadLetterQueueName)]);

  renderWranglerConfig({
    accountId,
    workerName,
    applicationUrl,
    publicCdnBase,
    database,
    bucketName: bucket.name || bucketName,
    eventQueueName,
    deadLetterQueueName,
    shopify,
  });
  renderShopifyConfig({ clientId: shopify.apiKey || 'YOUR_SHOPIFY_CLIENT_ID', applicationUrl });
  if (writeDeployRedirectFile) writeDeployRedirect();

  const manifest = {
    worker_name: workerName,
    application_url: applicationUrl,
    public_cdn_base: publicCdnBase,
    d1: { name: database.name, id: database.uuid, binding: 'DB' },
    r2_bucket: bucket.name || bucketName,
    queues: { events: eventQueueName, dead_letter: deadLetterQueueName },
    generated_config: generatedWranglerPath,
    generated_shopify_config: generatedShopifyPath,
    shopify_configured: shopify.configured,
  };
  writeFileSync(generatedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (migrateOnly || shouldDeploy) applyMigrations();
  if (shouldDeploy) deployWorker(workerName, shopify);
  writeGitHubMetadata(manifest);

  console.log(`\nDone. Application URL: ${applicationUrl}`);
  console.log(`Storefront CDN base: ${publicCdnBase}`);
  console.log(`Generated Wrangler config: ${generatedWranglerPath}`);
  console.log(`Generated Shopify config: ${generatedShopifyPath}`);
  if (!shopify.configured) {
    console.log('Replace SHOPIFY_API_KEY, SHOPIFY_API_SECRET, and APP_ENCRYPTION_KEY in Worker Settings → Variables and Secrets, change sensitive values to Secret, then deploy the settings.');
  }
  if (!shouldDeploy && !migrateOnly) console.log('Run npm run deploy to migrate and deploy everything.');
}

main().catch((error) => {
  console.error(`\nDeployment failed: ${error.message}`);
  process.exit(1);
});
