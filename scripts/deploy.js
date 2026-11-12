// Deploys only what is committed and tested: build → tests → clean git tree → wrangler deploy tagged with the commit.
// So production always matches a commit you can read, diff and roll back to (npx wrangler rollback, or deploy an older commit).
import { execSync } from 'node:child_process';

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });
const out = cmd => execSync(cmd, { encoding: 'utf8' }).trim();

run('node scripts/build.js');
const dirty = out('git status --porcelain');
if (dirty && !process.argv.includes('--allow-dirty')) {
  console.error('\nNot deploying: these files are not committed (the build may have just updated some of them):\n' + dirty + '\nCommit them, then run npm run deploy again.');
  process.exit(1);
}
run('npm test --silent');
const sha = out('git rev-parse --short HEAD');
run(`npx wrangler deploy --var VERSION:${sha}`);
console.log(`\nDeployed commit ${sha}.`);
