/**
 * Redis Metrics & Monitoring
 * Tracks connection health, latency, and operation performance for production monitoring
 */

export interface RedisMetrics {
    // Connection metrics
    connectionState: 'disconnected' | 'connecting' | 'connected' | 'failed';
    connectionAttempts: number;
    lastConnectionTime: Date | null;
    connectionLatencyMs: number | null;

    // Operation metrics
    totalOperations: number;
    successfulOperations: number;
    failedOperations: number;

    // Latency tracking (sliding window)
    avgLatencyMs: number;
    maxLatencyMs: number;
    minLatencyMs: number;
    p95LatencyMs: number;

    // Error tracking
    errorCount: number;
    lastError: string | null;
    lastErrorTime: Date | null;

    // Rate metrics
    operationsPerSecond: number;

    // Uptime
    uptimeMs: number;
}

export interface LatencyBucket {
    timestamp: number;
    latencyMs: number;
}

const LATENCY_WINDOW_SIZE = 100; // Keep last 100 operations for percentile calculations
const RATE_WINDOW_MS = 60000; // 1 minute window for ops/second calculation

class RedisMetricsTracker {
    private connectionState: RedisMetrics['connectionState'] = 'disconnected';
    private connectionAttempts: number = 0;
    private lastConnectionTime: Date | null = null;
    private connectionLatencyMs: number | null = null;
    private connectionStartTime: number | null = null;

    private totalOperations: number = 0;
    private successfulOperations: number = 0;
    private failedOperations: number = 0;

    private latencyBuckets: LatencyBucket[] = [];
    private operationTimestamps: number[] = [];

    private errorCount: number = 0;
    private lastError: string | null = null;
    private lastErrorTime: Date | null = null;

    private startTime: number = Date.now();

    /**
     * Record connection state change
     */
    recordConnectionStateChange(state: RedisMetrics['connectionState']): void {
        this.connectionState = state;

        if (state === 'connecting') {
            this.connectionStartTime = Date.now();
            this.connectionAttempts++;
        } else if (state === 'connected' && this.connectionStartTime) {
            this.connectionLatencyMs = Date.now() - this.connectionStartTime;
            this.lastConnectionTime = new Date();
            this.connectionStartTime = null;
            console.log(`📊 Redis connection established in ${this.connectionLatencyMs}ms`);
        } else if (state === 'failed') {
            this.connectionStartTime = null;
        }
    }

    /**
     * Record an operation with its latency
     */
    recordOperation(success: boolean, latencyMs: number): void {
        this.totalOperations++;

        if (success) {
            this.successfulOperations++;
        } else {
            this.failedOperations++;
        }

        // Add to latency window
        const now = Date.now();
        this.latencyBuckets.push({ timestamp: now, latencyMs });
        this.operationTimestamps.push(now);

        // Prune old entries
        if (this.latencyBuckets.length > LATENCY_WINDOW_SIZE) {
            this.latencyBuckets.shift();
        }

        // Prune operation timestamps older than rate window
        const cutoff = now - RATE_WINDOW_MS;
        this.operationTimestamps = this.operationTimestamps.filter(t => t > cutoff);

        // Warn on high latency
        if (latencyMs > 500) {
            console.warn(`⚠️ High Redis latency: ${latencyMs}ms`);
        }
    }

    /**
     * Record an error
     */
    recordError(error: Error | string): void {
        this.errorCount++;
        this.lastError = typeof error === 'string' ? error : error.message;
        this.lastErrorTime = new Date();
        console.error(`📊 Redis error recorded: ${this.lastError}`);
    }

    /**
     * Get current metrics snapshot
     */
    getMetrics(): RedisMetrics {
        const latencies = this.latencyBuckets.map(b => b.latencyMs);
        const sortedLatencies = [...latencies].sort((a, b) => a - b);

        return {
            // Connection metrics
            connectionState: this.connectionState,
            connectionAttempts: this.connectionAttempts,
            lastConnectionTime: this.lastConnectionTime,
            connectionLatencyMs: this.connectionLatencyMs,

            // Operation metrics
            totalOperations: this.totalOperations,
            successfulOperations: this.successfulOperations,
            failedOperations: this.failedOperations,

            // Latency (from sliding window)
            avgLatencyMs: this.calculateAvgLatency(latencies),
            maxLatencyMs: sortedLatencies.length > 0 ? sortedLatencies[sortedLatencies.length - 1] : 0,
            minLatencyMs: sortedLatencies.length > 0 ? sortedLatencies[0] : 0,
            p95LatencyMs: this.calculatePercentile(sortedLatencies, 95),

            // Errors
            errorCount: this.errorCount,
            lastError: this.lastError,
            lastErrorTime: this.lastErrorTime,

            // Rate
            operationsPerSecond: this.calculateOpsPerSecond(),

            // Uptime
            uptimeMs: Date.now() - this.startTime,
        };
    }

    /**
     * Get a formatted summary for logging
     */
    getSummary(): string {
        const metrics = this.getMetrics();
        const errorRate = metrics.totalOperations > 0
            ? ((metrics.failedOperations / metrics.totalOperations) * 100).toFixed(2)
            : 0;

        return `
📊 Redis Metrics Summary
━━━━━━━━━━━━━━━━━━━━━━━━
Connection: ${metrics.connectionState}
Uptime: ${Math.round(metrics.uptimeMs / 1000)}s
Operations: ${metrics.totalOperations} (${metrics.successfulOperations} success, ${metrics.failedOperations} failed)
Error Rate: ${errorRate}%
Latency: avg=${metrics.avgLatencyMs.toFixed(1)}ms, p95=${metrics.p95LatencyMs.toFixed(1)}ms, max=${metrics.maxLatencyMs.toFixed(1)}ms
Throughput: ${metrics.operationsPerSecond.toFixed(1)} ops/sec
${metrics.lastError ? `Last Error: ${metrics.lastError} at ${metrics.lastErrorTime?.toISOString()}` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━`;
    }

    /**
     * Reset all metrics
     */
    reset(): void {
        this.connectionAttempts = 0;
        this.totalOperations = 0;
        this.successfulOperations = 0;
        this.failedOperations = 0;
        this.latencyBuckets = [];
        this.operationTimestamps = [];
        this.errorCount = 0;
        this.lastError = null;
        this.lastErrorTime = null;
        this.startTime = Date.now();
    }

    private calculateAvgLatency(latencies: number[]): number {
        if (latencies.length === 0) return 0;
        return latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
    }

    private calculatePercentile(sortedValues: number[], percentile: number): number {
        if (sortedValues.length === 0) return 0;
        const index = Math.ceil((percentile / 100) * sortedValues.length) - 1;
        return sortedValues[Math.max(0, index)];
    }

    private calculateOpsPerSecond(): number {
        const now = Date.now();
        const recentOps = this.operationTimestamps.filter(t => t > now - RATE_WINDOW_MS);
        return (recentOps.length / RATE_WINDOW_MS) * 1000;
    }
}

// Singleton instance
const metricsTracker = new RedisMetricsTracker();

export function getRedisMetrics(): RedisMetrics {
    return metricsTracker.getMetrics();
}

export function getRedisMetricsSummary(): string {
    return metricsTracker.getSummary();
}

export function recordRedisConnectionState(state: RedisMetrics['connectionState']): void {
    metricsTracker.recordConnectionStateChange(state);
}

export function recordRedisOperation(success: boolean, latencyMs: number): void {
    metricsTracker.recordOperation(success, latencyMs);
}

export function recordRedisError(error: Error | string): void {
    metricsTracker.recordError(error);
}

export function resetRedisMetrics(): void {
    metricsTracker.reset();
}
