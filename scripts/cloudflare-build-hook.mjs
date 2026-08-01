import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWorkersBuild = process.env.WORKERS_CI === '1' || Boolean(process.env.WORKERS_CI_BUILD_UUID);
const alreadyBootstrapping = process.env.SHOPIFY_REVIEWS_BOOTSTRAP_ACTIVE === '1';
const productionBranch = process.env.CLOUDFLARE_PRODUCTION_BRANCH || 'main';
const currentBranch = process.env.WORKERS_CI_BRANCH || '';

if (!isWorkersBuild) {
  console.log('Cloudflare resource bootstrap skipped outside Workers Builds. Use `npm run deploy` for a full deployment.');
  process.exit(0);
}

if (alreadyBootstrapping) {
  console.log('Cloudflare resource bootstrap is already active; skipping nested hook.');
  process.exit(0);
}

if (currentBranch && currentBranch !== productionBranch) {
  console.log(`Cloudflare resource bootstrap skipped for preview branch ${currentBranch}; production branch is ${productionBranch}.`);
  process.exit(0);
}

console.log('Workers Builds detected. Provisioning D1, R2, Queues, migrations, bindings, and generated configuration…');
const result = spawnSync(
  process.execPath,
  ['scripts/provision.mjs', '--deploy', '--ci', '--write-deploy-redirect'],
  {
    cwd: root,
    env: { ...process.env, SHOPIFY_REVIEWS_BOOTSTRAP_ACTIVE: '1' },
    stdio: 'inherit',
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
