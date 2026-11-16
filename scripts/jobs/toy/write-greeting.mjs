// Toy helper: writes its single argument to greeting.txt in the current directory.
// Honours the jobs idempotency convention: a repeat of the same ORION_JOB_IDEMPOTENCY_KEY
// is a no-op that says "already done"; the marker is written only after the effect.
import { existsSync, writeFileSync } from 'node:fs';

const text = process.argv[2];
if (typeof text !== 'string' || text.length === 0 || text.length > 200) {
  process.stderr.write('write-greeting: expected one short text argument\n');
  process.exit(2);
}
const key = process.env.ORION_JOB_IDEMPOTENCY_KEY;
const marker = key && /^[0-9a-f]{32}$/.test(key) ? `.done-${key}` : null;
if (marker && existsSync(marker)) {
  process.stdout.write('already done\n');
  process.exit(0);
}
writeFileSync('greeting.txt', `${text}\n`, { mode: 0o600 });
if (marker) writeFileSync(marker, 'done\n', { mode: 0o600 });
process.stdout.write('wrote greeting.txt\n');
