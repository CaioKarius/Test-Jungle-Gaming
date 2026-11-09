/**
 * Minimal load generator (no dependencies). Usage:
 *   bun run test:load -- --targets http://localhost:3001,http://localhost:3002,http://localhost:3003 \
 *       --wallets 200 --concurrency 64 --duration 30
 * Spreads BET/WIN pairs over many wallets, reports throughput, latency percentiles, status
 * histogram, and finally reconciles every wallet and reads outbox lag from /metrics.
 * It generates the workload; it does NOT ship pre-recorded results (numbers depend on the machine).
 */
export {};

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] as string) : fallback;
};

const targets = arg('targets', 'http://localhost:3001,http://localhost:3002,http://localhost:3003').split(',');
const walletCount = Number(arg('wallets', '200'));
const concurrency = Number(arg('concurrency', '64'));
const durationMs = Number(arg('duration', '30')) * 1000;
const run = Date.now().toString(36);

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

const wallets: Array<{ id: string; player: string }> = [];
for (let i = 0; i < walletCount; i++) {
  const player = `load-${run}-${i}`;
  const res = await call(targets[i % targets.length]!, 'POST', '/wallets', { playerId: player, initialBalance: { amount: '100000.00', currency: 'BRL' } });
  wallets.push({ id: res.json.id, player });
}

const latencies: number[] = [];
const statuses = new Map<number, number>();
let counter = 0;
const deadline = Date.now() + durationMs;

async function worker(n: number) {
  while (Date.now() < deadline) {
    const seq = counter++;
    const w = wallets[seq % wallets.length]!;
    const kind = seq % 3 === 2 ? 'WIN' : 'BET';
    const data = {
      providerId: 'load', externalTransactionId: `${run}-${seq}`, playerId: w.player, walletId: w.id,
      roundId: `r-${seq}`, gameId: 'load-game', kind, money: { amount: '1.00', currency: 'BRL' },
    };
    const started = performance.now();
    try {
      const res = await call(targets[(seq + n) % targets.length]!, 'POST', '/wagering/transactions', data, { 'idempotency-key': `load:${run}-${seq}` });
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    } catch {
      statuses.set(-1, (statuses.get(-1) ?? 0) + 1);
    }
    latencies.push(performance.now() - started);
  }
}

const startedAt = performance.now();
await Promise.all(Array.from({ length: concurrency }, (_, n) => worker(n)));
const elapsed = (performance.now() - startedAt) / 1000;

latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]?.toFixed(1);
console.log(`requests: ${latencies.length}  elapsed: ${elapsed.toFixed(1)}s  throughput: ${(latencies.length / elapsed).toFixed(0)} req/s`);
console.log(`latency ms  p50=${pct(50)} p95=${pct(95)} p99=${pct(99)} max=${latencies[latencies.length - 1]?.toFixed(1)}`);
console.log('status histogram:', Object.fromEntries(statuses));

let divergent = 0;
for (const [i, w] of wallets.entries()) {
  const r = await call(targets[i % targets.length]!, 'POST', `/wallets/${w.id}/reconciliation`);
  if (!r.json.consistent) divergent++;
}
console.log(`reconciliation: ${wallets.length - divergent}/${wallets.length} wallets consistent`);

for (const target of targets) {
  const metrics = await (await fetch(`${target}/metrics`)).text();
  const lag = /^outbox_lag_seconds\s+([\d.]+)/m.exec(metrics)?.[1];
  const conflicts = [...metrics.matchAll(/^lock_conflicts_total\{[^}]*\}\s+([\d.]+)/gm)].reduce((s, m) => s + Number(m[1]), 0);
  console.log(`${target}  outbox_lag_seconds=${lag ?? 'n/a'}  lock_conflicts=${conflicts}`);
}
