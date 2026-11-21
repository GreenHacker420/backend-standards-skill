import { describe, it, expect, vi } from 'vitest';
import { Singleflight } from '../examples/resilience/singleflight';
import { TailSampler } from '../examples/observability/tail-sampler';

describe('Advanced Resilience & Observability', () => {
    describe('Singleflight Promise Coalescing', () => {
        it('coalesces multiple concurrent executions of identical keys into one', async () => {
            const sf = new Singleflight();
            let executionCount = 0;

            const expensiveWork = () =>
                new Promise<string>((resolve) => {
                    executionCount++;
                    setTimeout(() => resolve('data'), 20);
                });

            const results = await Promise.all([
                sf.do('key-1', expensiveWork),
                sf.do('key-1', expensiveWork),
                sf.do('key-1', expensiveWork),
            ]);

            expect(results).toEqual(['data', 'data', 'data']);
            expect(executionCount).toBe(1);
            expect(sf.activeCount()).toBe(0);
        });

        it('cleans up in-flight entries on rejection', async () => {
            const sf = new Singleflight();

            await expect(
                sf.do('err-key', async () => {
                    throw new Error('fail');
                })
            ).rejects.toThrow('fail');

            expect(sf.activeCount()).toBe(0);
        });
    });

    describe('TailSampler Heuristics', () => {
        it('samples 100% of errors and slow requests while downsampling healthy fast traces', () => {
            const sampler = new TailSampler({
                errorSamplingRate: 1.0,
                slowSamplingRate: 1.0,
                slowThresholdMs: 500,
                baselineSamplingRate: 0.0, // Drop all healthy fast traces
            });

            // Trace 1: Error trace
            sampler.recordSpan({
                traceId: 'trace-error',
                spanId: 's1',
                name: 'GET /checkout',
                startTime: Date.now(),
                attributes: {},
            });
            const errorResult = sampler.evaluateTrace('trace-error', { statusCode: 500, durationMs: 50 });
            expect(errorResult.sampled).toBe(true);
            expect(errorResult.reason).toBe('error_retention');

            // Trace 2: Slow outlier trace
            sampler.recordSpan({
                traceId: 'trace-slow',
                spanId: 's2',
                name: 'POST /reports',
                startTime: Date.now(),
                attributes: {},
            });
            const slowResult = sampler.evaluateTrace('trace-slow', { statusCode: 200, durationMs: 1200 });
            expect(slowResult.sampled).toBe(true);
            expect(slowResult.reason).toBe('slow_outlier_retention');

            // Trace 3: Healthy fast trace
            sampler.recordSpan({
                traceId: 'trace-fast',
                spanId: 's3',
                name: 'GET /health',
                startTime: Date.now(),
                attributes: {},
            });
            const fastResult = sampler.evaluateTrace('trace-fast', { statusCode: 200, durationMs: 10 });
            expect(fastResult.sampled).toBe(false);
            expect(fastResult.reason).toBe('dropped_healthy_fast_trace');
        });

        it('appends spans to active traces without rejecting them when capacity is reached', () => {
            const sampler = new TailSampler({
                maxActiveTraces: 2,
                maxSpansPerTrace: 5,
                baselineSamplingRate: 1.0,
            });

            sampler.recordSpan({ traceId: 't1', spanId: 's1', name: 'span1', startTime: 1, attributes: {} });
            sampler.recordSpan({ traceId: 't2', spanId: 's1', name: 'span1', startTime: 1, attributes: {} });

            // Capacity of 2 active traces reached.
            // Appending a second span to EXISTING active trace 't1' must succeed!
            sampler.recordSpan({ traceId: 't1', spanId: 's2', name: 'span2', startTime: 2, attributes: {} });

            const t1 = sampler.evaluateTrace('t1', { statusCode: 200, durationMs: 100 });
            expect(t1.spans).toHaveLength(2);
        });
    });
});
