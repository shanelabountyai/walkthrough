import { execSync } from 'node:child_process';

// Seed the demo orgs once, before any worker starts. Several specs also run `seed:demo:test` in their beforeAll; on an
// empty database two workers doing that at once both miss the `acme` org in `upsert` and both insert it, and the loser
// fails on Org_slug_key (CI run 43953134490, e2e/demo.spec.ts). Once the orgs exist, those per-spec seeds are
// idempotent updates and cannot race on the insert.
export default function globalSetup() {
  execSync('npm run seed:demo:test', { stdio: 'inherit' });
}
