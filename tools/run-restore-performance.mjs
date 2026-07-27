import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const [, , suite = 'stress', profile = 'smoke'] = process.argv;
const configurations = {
  stress: 'vitest.stress.config.ts',
  benchmark: 'vitest.benchmark.config.ts',
  heap: 'vitest.stress.config.ts',
};
const config = configurations[suite];
if (config === undefined) {
  process.stderr.write(`Unknown restore performance suite: ${suite}\n`);
  process.exitCode = 2;
} else {
  const vitest = resolve('node_modules/vitest/vitest.mjs');
  const nodeArguments = [
    ...(suite === 'heap'
      ? [`--max-old-space-size=${process.env.RESTORE_TEST_HEAP_MB ?? '256'}`]
      : []),
    vitest,
    'run',
    '--config',
    config,
  ];
  const result = spawnSync(process.execPath, nodeArguments, {
    stdio: 'inherit',
    env: {
      ...process.env,
      RESTORE_STRESS_PROFILE: profile,
    },
  });
  if (result.error !== undefined) throw result.error;
  process.exitCode = result.status ?? 1;
}
