import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  compareRestoreBenchmark,
  restoreBenchmarkBaselineKey,
  type RestoreBenchmarkRegression,
  type RestoreBenchmarkResult,
} from './restoreWorkload.js';

export interface RestoreBenchmarkRunArtifact {
  readonly generatedAt: string;
  readonly warmupRuns: number;
  readonly measuredRuns: number;
  readonly measurements: readonly RestoreBenchmarkResult[];
  readonly median: RestoreBenchmarkResult;
  readonly regression?: RestoreBenchmarkRegression;
}

function medianNumber(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function medianRestoreBenchmark(
  measurements: readonly RestoreBenchmarkResult[],
): RestoreBenchmarkResult {
  if (measurements.length === 0) throw new Error('At least one benchmark measurement is required.');
  const representative = measurements[Math.floor(measurements.length / 2)]!;
  return {
    ...representative,
    rowCount: Math.round(medianNumber(measurements.map((item) => item.rowCount))),
    logicalBytes: Math.round(medianNumber(measurements.map((item) => item.logicalBytes))),
    totalDurationMilliseconds: medianNumber(
      measurements.map((item) => item.totalDurationMilliseconds),
    ),
    copyDurationMilliseconds: medianNumber(
      measurements.map((item) => item.copyDurationMilliseconds),
    ),
    archiveReadDurationMilliseconds: medianNumber(
      measurements.map((item) => item.archiveReadDurationMilliseconds),
    ),
    validationDurationMilliseconds: medianNumber(
      measurements.map((item) => item.validationDurationMilliseconds),
    ),
    rowsPerSecond: medianNumber(measurements.map((item) => item.rowsPerSecond)),
    logicalMegabytesPerSecond: medianNumber(
      measurements.map((item) => item.logicalMegabytesPerSecond),
    ),
    baselineRss: Math.round(medianNumber(measurements.map((item) => item.baselineRss))),
    peakRss: Math.round(medianNumber(measurements.map((item) => item.peakRss))),
    peakHeapUsed: Math.round(medianNumber(measurements.map((item) => item.peakHeapUsed))),
    progressEventCount: Math.round(
      medianNumber(measurements.map((item) => item.progressEventCount)),
    ),
  };
}

export async function loadRestoreBenchmarkBaseline(
  directory: string,
  measurement: RestoreBenchmarkResult,
): Promise<RestoreBenchmarkResult | undefined> {
  const file = join(resolve(directory), `${restoreBenchmarkBaselineKey(measurement)}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as RestoreBenchmarkResult;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  }
}

export async function saveRestoreBenchmarkArtifact(
  artifact: RestoreBenchmarkRunArtifact,
  outputFile: string,
): Promise<void> {
  const absolute = resolve(outputFile);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

export async function saveRestoreBenchmarkBaseline(
  directory: string,
  measurement: RestoreBenchmarkResult,
): Promise<string> {
  const file = join(resolve(directory), `${restoreBenchmarkBaselineKey(measurement)}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(measurement, null, 2)}\n`, 'utf8');
  return file;
}

export function evaluateRestoreBenchmarkBaseline(
  current: RestoreBenchmarkResult,
  baseline: RestoreBenchmarkResult | undefined,
): RestoreBenchmarkRegression | undefined {
  if (baseline === undefined) return undefined;
  return compareRestoreBenchmark(current, baseline, {
    throughputWarningPercent: Number(process.env.RESTORE_BENCHMARK_WARN_PERCENT ?? '20'),
    memoryFailurePercent: Number(process.env.RESTORE_BENCHMARK_MEMORY_PERCENT ?? '50'),
    enforcePerformance: process.env.RESTORE_BENCHMARK_ENFORCE === '1',
  });
}
