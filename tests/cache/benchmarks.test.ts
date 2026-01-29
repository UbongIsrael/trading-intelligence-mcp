/**
 * Cache Performance Benchmarks
 * Run with: npm test -- benchmarks.test.ts --verbose
 */

import { getCacheService } from '../../src/cache/index';
import { initializeRedis, shutdownRedis } from '../../src/cache/redis';
import { config } from '../../src/config';
import { PriceData } from '../../src/types';

interface BenchmarkResult {
  operation: string;
  iterations: number;
  totalTime: number;
  avgTime: number;
  minTime: number;
  maxTime: number;
  opsPerSecond: number;
}

function runBenchmark(
  name: string,
  iterations: number,
  operation: () => Promise<void>
): Promise<BenchmarkResult> {
  return new Promise(async (resolve) => {
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await operation();
      const end = performance.now();
      times.push(end - start);
    }

    const totalTime = times.reduce((sum, t) => sum + t, 0);
    const avgTime = totalTime / iterations;
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const opsPerSecond = 1000 / avgTime;

    resolve({
      operation: name,
      iterations,
      totalTime,
      avgTime,
      minTime,
      maxTime,
      opsPerSecond,
    });
  });
}

function formatBenchmarkResult(result: BenchmarkResult): string {
  return `
${result.operation}:
  Iterations: ${result.iterations}
  Total Time: ${result.totalTime.toFixed(2)}ms
  Avg Time: ${result.avgTime.toFixed(2)}ms
  Min Time: ${result.minTime.toFixed(2)}ms
  Max Time: ${result.maxTime.toFixed(2)}ms
  Ops/Second: ${result.opsPerSecond.toFixed(2)}
  `;
}

describe('Cache Performance Benchmarks', () => {
  let cacheService: ReturnType<typeof getCacheService>;

  beforeAll(async () => {
    if (config.features.enableCaching) {
      await initializeRedis();
      cacheService = getCacheService();
      await cacheService.flush();
    }
  });

  afterAll(async () => {
    if (config.features.enableCaching) {
      await shutdownRedis();
    }
  });

  test('SET operation benchmark', async () => {
    if (!config.features.enableCaching) {
      console.log('Skipping: Caching disabled');
      return;
    }

    const iterations = 100;
    const testData: PriceData = {
      symbol: 'BENCH',
      price: 100.5,
      currency: 'USD',
      timestamp: new Date(),
      source: 'benchmark',
    };

    const result = await runBenchmark(
      'Cache SET',
      iterations,
      async () => {
        await cacheService.prices.set(`BENCH-${Math.random()}`, testData);
      }
    );

    console.log(formatBenchmarkResult(result));

    // Performance expectations (relaxed for networked Redis)
    expect(result.avgTime).toBeLessThan(500); // <500ms average
    expect(result.maxTime).toBeLessThan(1000); // <1000ms worst case
  }, 60000);

  test('GET operation benchmark (cache hit)', async () => {
    if (!config.features.enableCaching) return;

    const testData: PriceData = {
      symbol: 'BENCH',
      price: 100.5,
      currency: 'USD',
      timestamp: new Date(),
      source: 'benchmark',
    };

    // Pre-populate cache
    await cacheService.prices.set('BENCH-GET', testData);

    const iterations = 100;
    const result = await runBenchmark(
      'Cache GET (hit)',
      iterations,
      async () => {
        await cacheService.prices.get('BENCH-GET');
      }
    );

    console.log(formatBenchmarkResult(result));

    // Performance expectations (relaxed for networked Redis)
    expect(result.avgTime).toBeLessThan(500); // <500ms average
    expect(result.maxTime).toBeLessThan(1000); // <1000ms worst case
  }, 60000);

  test('GET operation benchmark (cache miss)', async () => {
    if (!config.features.enableCaching) return;

    const iterations = 100;
    const result = await runBenchmark(
      'Cache GET (miss)',
      iterations,
      async () => {
        await cacheService.prices.get(`MISS-${Math.random()}`);
      }
    );

    console.log(formatBenchmarkResult(result));

    expect(result.avgTime).toBeLessThan(500); // <500ms average
  }, 60000);

  test('Cache-aside pattern benchmark', async () => {
    if (!config.features.enableCaching) return;

    let counter = 0;
    const fetcher = async (): Promise<PriceData> => {
      counter++;
      // Simulate API call delay
      await new Promise(resolve => setTimeout(resolve, 10));
      return {
        symbol: 'ASIDE',
        price: 100,
        currency: 'USD',
        timestamp: new Date(),
        source: 'benchmark',
      };
    };

    const iterations = 50;
    const result = await runBenchmark(
      'Cache-Aside Pattern',
      iterations,
      async () => {
        await cacheService.prices.getOrFetch('ASIDE-BENCH', fetcher);
      }
    );

    console.log(formatBenchmarkResult(result));
    console.log(`Fetcher called: ${counter} times (should be 1)`);

    expect(counter).toBe(1); // Fetcher should only be called once
  }, 30000);

  test('Batch SET benchmark', async () => {
    if (!config.features.enableCaching) return;

    const batchSize = 10;
    const iterations = 20;

    const result = await runBenchmark(
      `Batch SET (${batchSize} items)`,
      iterations,
      async () => {
        const batch = new Map<string, PriceData>();
        for (let i = 0; i < batchSize; i++) {
          batch.set(`BATCH-${i}`, {
            symbol: `SYM${i}`,
            price: Math.random() * 1000,
            currency: 'USD',
            timestamp: new Date(),
            source: 'benchmark',
          });
        }
        await cacheService.prices.batchSet(batch);
      }
    );

    console.log(formatBenchmarkResult(result));

    // Batch operations should be efficient (relaxed for networked Redis)
    const avgTimePerItem = result.avgTime / batchSize;
    expect(avgTimePerItem).toBeLessThan(100); // <100ms per item in batch
  }, 60000);

  test('Batch GET benchmark', async () => {
    if (!config.features.enableCaching) return;

    // Pre-populate
    const batch = new Map<string, PriceData>();
    for (let i = 0; i < 10; i++) {
      batch.set(`BATCH-GET-${i}`, {
        symbol: `SYM${i}`,
        price: 100,
        currency: 'USD',
        timestamp: new Date(),
        source: 'benchmark',
      });
    }
    await cacheService.prices.batchSet(batch);

    const iterations = 20;
    const keys = Array.from({ length: 10 }, (_, i) => `BATCH-GET-${i}`);

    const result = await runBenchmark(
      'Batch GET (10 items)',
      iterations,
      async () => {
        await cacheService.prices.batchGet(keys);
      }
    );

    console.log(formatBenchmarkResult(result));

    const avgTimePerItem = result.avgTime / 10;
    expect(avgTimePerItem).toBeLessThan(100); // <100ms per item in batch
  }, 60000);

  test('Large data payload benchmark', async () => {
    if (!config.features.enableCaching) return;

    const largeData: PriceData = {
      symbol: 'LARGE',
      price: 100,
      currency: 'USD',
      timestamp: new Date(),
      source: 'benchmark',
      // Add large metadata
      metadata: {
        history: Array.from({ length: 1000 }, (_, i) => ({
          timestamp: new Date(Date.now() - i * 60000),
          price: 100 + Math.random() * 10,
        })),
      },
    } as any;

    const iterations = 20;
    const result = await runBenchmark(
      'Large Data (1000 records)',
      iterations,
      async () => {
        await cacheService.prices.set('LARGE-DATA', largeData);
        await cacheService.prices.get('LARGE-DATA');
      }
    );

    console.log(formatBenchmarkResult(result));

    // Should handle large data reasonably (relaxed for networked Redis)
    expect(result.avgTime).toBeLessThan(2000); // <2000ms for large data over network
  }, 60000);

  test('Concurrent operations benchmark', async () => {
    if (!config.features.enableCaching) return;

    const concurrentOps = 10;
    const iterations = 10;

    const result = await runBenchmark(
      `Concurrent Operations (${concurrentOps} parallel)`,
      iterations,
      async () => {
        const promises = [];
        for (let i = 0; i < concurrentOps; i++) {
          promises.push(
            cacheService.prices.set(`CONCURRENT-${i}`, {
              symbol: `SYM${i}`,
              price: 100,
              currency: 'USD',
              timestamp: new Date(),
              source: 'benchmark',
            })
          );
        }
        await Promise.all(promises);
      }
    );

    console.log(formatBenchmarkResult(result));

    // Concurrent operations should be efficient (relaxed for networked Redis)
    expect(result.avgTime).toBeLessThan(500); // <500ms
  }, 60000);

  test('Health check benchmark', async () => {
    if (!config.features.enableCaching) return;

    const iterations = 50;
    const result = await runBenchmark(
      'Health Check',
      iterations,
      async () => {
        await cacheService.healthCheck();
      }
    );

    console.log(formatBenchmarkResult(result));

    // Health checks should be reasonably fast (relaxed for networked Redis)
    expect(result.avgTime).toBeLessThan(500); // <500ms
  }, 60000);

  test('Overall performance summary', async () => {
    if (!config.features.enableCaching) return;

    console.log('\n=== PERFORMANCE SUMMARY ===\n');

    const stats = cacheService.getStats();
    console.log('Cache Statistics:');
    console.log(`  Hit Rate: ${(stats.hitRate * 100).toFixed(2)}%`);
    console.log(`  Total Hits: ${stats.hits}`);
    console.log(`  Total Misses: ${stats.misses}`);
    console.log(`  Operations: GET=${stats.operations.get}, SET=${stats.operations.set}, DELETE=${stats.operations.delete}`);

    const health = await cacheService.healthCheck();
    if (health.latency) {
      console.log(`\nRedis Latency: ${health.latency}ms`);
    }

    console.log('\n===========================\n');
  });
});
