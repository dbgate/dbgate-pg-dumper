import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createRestoreEngine,
  type RestoreProgressEvent,
  type RestoreValidationLevel,
} from '../../src/index.js';
import {
  NativeRestoreFixture,
  restoreFailureContext,
} from '../integration/support/nativeRestoreTestSupport.js';
import {
  evaluateRestoreBenchmarkBaseline,
  loadRestoreBenchmarkBaseline,
  medianRestoreBenchmark,
  saveRestoreBenchmarkArtifact,
  saveRestoreBenchmarkBaseline,
} from './restoreBenchmarkArtifacts.js';
import {
  benchmarkResult,
  createRestoreStressArchive,
  formatRestoreBenchmark,
  resolveRestoreWorkloadConfiguration,
  RestoreMemorySampler,
  type RestoreBenchmarkResult,
} from './restoreWorkload.js';

function integerEnvironment(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name] ?? String(fallback));
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer greater than or equal to ${String(minimum)}.`);
  }
  return value;
}

function validationLevels(): readonly RestoreValidationLevel[] {
  const values = (process.env.RESTORE_BENCHMARK_VALIDATION_LEVELS ?? 'none,basic')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean) as RestoreValidationLevel[];
  const supported: readonly RestoreValidationLevel[] = [
    'none',
    'basic',
    'structure',
    'structure-and-data',
    'full',
  ];
  for (const value of values) {
    if (!supported.includes(value)) throw new Error(`Unsupported validation level: ${value}`);
  }
  return values;
}

async function measuredRestore(
  validationLevel: RestoreValidationLevel,
  record: boolean,
): Promise<RestoreBenchmarkResult | undefined> {
  const configuration = resolveRestoreWorkloadConfiguration();
  const fixture = await NativeRestoreFixture.create('native_benchmark');
  const source = createRestoreStressArchive(fixture, configuration);
  const memory = new RestoreMemorySampler();
  const progress: RestoreProgressEvent[] = [];

  try {
    memory.start();
    const result = await createRestoreEngine().restore({
      archive: source.archive,
      target: fixture.target,
      options: { transactionMode: 'single', validationLevel },
      onProgress: (event) => {
        memory.phase = event.phase;
        progress.push(event);
      },
    });
    const summary = memory.stop();
    expect(result.status, restoreFailureContext(result)).toBe('success');
    expect(result.restoredRowCount).toBe(configuration.rowCount);
    if (!record) return undefined;
    return benchmarkResult(
      `native-restore-${validationLevel}`,
      configuration,
      result,
      summary,
      progress.length,
      { validationLevel, transactionMode: 'single' },
    );
  } finally {
    memory.stop();
    await fixture.close();
  }
}

describe('native PostgreSQL restore benchmark', () => {
  for (const validationLevel of validationLevels()) {
    it(`records direct-stream throughput and memory with ${validationLevel} validation`, async () => {
      const configuration = resolveRestoreWorkloadConfiguration();
      if (
        configuration.profile === 'manual-extreme' &&
        process.env.RUN_EXTREME_RESTORE_TESTS !== '1'
      ) {
        throw new Error(
          'manual-extreme requires RUN_EXTREME_RESTORE_TESTS=1 to prevent accidental multi-gigabyte runs.',
        );
      }
      const warmups = integerEnvironment('RESTORE_BENCHMARK_WARMUPS', 1, 0);
      const runs = integerEnvironment(
        'RESTORE_BENCHMARK_RUNS',
        configuration.profile === 'manual-extreme' ? 1 : 3,
        1,
      );
      for (let index = 0; index < warmups; index += 1) {
        await measuredRestore(validationLevel, false);
      }
      const measurements: RestoreBenchmarkResult[] = [];
      for (let index = 0; index < runs; index += 1) {
        measurements.push((await measuredRestore(validationLevel, true))!);
      }
      const median = medianRestoreBenchmark(measurements);
      const baselineDirectory = process.env.RESTORE_BENCHMARK_BASELINE_DIR;
      const baseline =
        baselineDirectory === undefined
          ? undefined
          : await loadRestoreBenchmarkBaseline(baselineDirectory, median);
      const regression = evaluateRestoreBenchmarkBaseline(median, baseline);
      const artifact = {
        generatedAt: new Date().toISOString(),
        warmupRuns: warmups,
        measuredRuns: runs,
        measurements,
        median,
        ...(regression === undefined ? {} : { regression }),
      };
      const outputDirectory =
        process.env.RESTORE_BENCHMARK_OUTPUT_DIR ?? 'test-output/restore-performance';
      await saveRestoreBenchmarkArtifact(
        artifact,
        join(outputDirectory, `${median.benchmarkName}-${median.workloadProfile}.json`),
      );
      if (process.env.RESTORE_BENCHMARK_SAVE_BASELINE === '1') {
        await saveRestoreBenchmarkBaseline(
          baselineDirectory ?? join(outputDirectory, 'baselines'),
          median,
        );
      }
      process.stdout.write(`${formatRestoreBenchmark(median)}\n`);
      for (const warning of regression?.warnings ?? [])
        process.stderr.write(`WARNING: ${warning}\n`);
      expect(regression?.failures ?? []).toEqual([]);
    });
  }
});
