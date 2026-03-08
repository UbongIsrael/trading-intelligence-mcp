/**
 * Alpha Vantage API Key Pool Manager
 * 
 * Manages multiple API keys with per-key rate limiting and daily quotas.
 * Enables true parallel requests by dispatching concurrent calls across
 * different keys, each with independent rate-limit windows.
 * 
 * Supports:
 * - Multiple free-tier keys (5/min, 25/day each)
 * - Optional premium key (75/min, unlimited daily)
 * - Automatic key selection (least-recently-used)
 * - Backward compatibility with single ALPHA_VANTAGE_API_KEY
 */

import { Mutex } from '../utils/mutex.js';
import { APIError } from '../types.js';

// ─────────────────────────────────────────────────────────
// Rate limit constants
// ─────────────────────────────────────────────────────────

const FREE_RATE_LIMIT_DELAY = 12000;   // 12s = 5 requests/minute
const PREMIUM_RATE_LIMIT_DELAY = 800;  // 0.8s = 75 requests/minute
const FREE_DAILY_LIMIT = 25;
const FREE_DAILY_LIMIT_WARNING = 20;

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface ManagedKey {
    key: string;
    label: string;           // e.g. "key-1", "key-2 (premium)"
    isPremium: boolean;
    dailyCount: number;
    dailyLimit: number;      // 25 for free, Infinity for premium
    rateLimitDelay: number;  // ms between requests on this key
    lastRequestTime: number;
    lastResetDate: string;
    mutex: Mutex;            // per-key mutex for sequential requests on same key
}

export interface PoolStats {
    totalKeys: number;
    premiumKeys: number;
    freeKeys: number;
    keys: Array<{
        label: string;
        isPremium: boolean;
        dailyUsed: number;
        dailyLimit: number | string;
        available: boolean;
    }>;
    totalDailyUsed: number;
    totalDailyLimit: number | string;
}

// ─────────────────────────────────────────────────────────
// ApiKeyPool
// ─────────────────────────────────────────────────────────

export class ApiKeyPool {
    private keys: ManagedKey[] = [];

    constructor() {
        this.loadKeys();
    }

    /**
     * Load keys from environment variables.
     * Priority: ALPHA_VANTAGE_API_KEYS (comma-separated) > ALPHA_VANTAGE_API_KEY (single)
     */
    private loadKeys(): void {
        const multiKeyStr = process.env.ALPHA_VANTAGE_API_KEYS;
        const singleKey = process.env.ALPHA_VANTAGE_API_KEY;
        const premiumKeyStr = process.env.ALPHA_VANTAGE_PREMIUM_KEY?.trim() || null;

        let rawKeys: string[] = [];

        if (multiKeyStr) {
            rawKeys = multiKeyStr.split(',').map(k => k.trim()).filter(Boolean);
        }

        // Fallback: use single key if multi-key not set
        if (rawKeys.length === 0 && singleKey && singleKey !== 'demo') {
            rawKeys = [singleKey.trim()];
        }

        if (rawKeys.length === 0) {
            console.warn('⚠️ [Key Pool] No Alpha Vantage API keys configured');
            return;
        }

        // De-duplicate keys
        const uniqueKeys = [...new Set(rawKeys)];

        this.keys = uniqueKeys.map((key, index) => {
            const isPremium = premiumKeyStr !== null && key === premiumKeyStr;
            const label = `key-${index + 1}${isPremium ? ' (premium)' : ''}`;

            return {
                key,
                label,
                isPremium,
                dailyCount: 0,
                dailyLimit: isPremium ? Infinity : FREE_DAILY_LIMIT,
                rateLimitDelay: isPremium ? PREMIUM_RATE_LIMIT_DELAY : FREE_RATE_LIMIT_DELAY,
                lastRequestTime: 0,
                lastResetDate: new Date().toDateString(),
                mutex: new Mutex(),
            };
        });

        const premiumCount = this.keys.filter(k => k.isPremium).length;
        const freeCount = this.keys.length - premiumCount;
        console.log(`🔑 [Key Pool] Initialized with ${this.keys.length} keys (${freeCount} free, ${premiumCount} premium)`);
    }

    /**
     * Check if the pool has any keys configured.
     */
    hasKeys(): boolean {
        return this.keys.length > 0;
    }

    /**
     * Get the total number of keys in the pool.
     */
    get size(): number {
        return this.keys.length;
    }

    /**
     * Reset daily counter for a key if the date has changed.
     */
    private checkAndResetKey(key: ManagedKey): void {
        const today = new Date().toDateString();
        if (today !== key.lastResetDate) {
            console.log(`🔄 [Key Pool] Daily counter reset for ${key.label} (was ${key.dailyCount}/${key.isPremium ? '∞' : key.dailyLimit})`);
            key.dailyCount = 0;
            key.lastResetDate = today;
        }
    }

    /**
     * Select the best available key for a request.
     * 
     * Strategy:
     *   1. Reset daily counters if new day
     *   2. Filter out keys that have hit their daily limit
     *   3. Prefer premium key if it is idle (time since last request > its rate delay)
     *   4. Among remaining keys, pick the one with the longest idle time
     *   5. If all keys exhausted, throw DAILY_LIMIT_REACHED
     */
    acquireKey(): ManagedKey {
        if (this.keys.length === 0) {
            throw new APIError(
                'Alpha Vantage API key not configured. Set ALPHA_VANTAGE_API_KEYS or ALPHA_VANTAGE_API_KEY environment variable.',
                {
                    suggestion: 'Get a free API key at https://www.alphavantage.co/support/#api-key',
                    code: 'MISSING_API_KEY'
                }
            );
        }

        // Reset daily counters
        for (const key of this.keys) {
            this.checkAndResetKey(key);
        }

        // Filter to keys with remaining daily quota
        const available = this.keys.filter(k => k.dailyCount < k.dailyLimit);

        if (available.length === 0) {
            const totalUsed = this.keys.reduce((sum, k) => sum + k.dailyCount, 0);
            const totalLimit = this.keys.reduce((sum, k) => sum + (k.isPremium ? 0 : k.dailyLimit), 0);
            throw new APIError(
                `All Alpha Vantage API keys have hit their daily limit (${totalUsed} total requests across ${this.keys.length} keys). Data will refresh tomorrow or upgrade a key to Premium tier.`,
                {
                    code: 'DAILY_LIMIT_REACHED',
                    totalKeys: this.keys.length,
                    totalUsed,
                    totalLimit,
                    upgradeUrl: 'https://www.alphavantage.co/premium/',
                    resetTime: new Date(new Date().setHours(24, 0, 0, 0))
                }
            );
        }

        const now = Date.now();

        // Prefer premium key if idle
        const premiumIdle = available.find(
            k => k.isPremium && (now - k.lastRequestTime) >= k.rateLimitDelay
        );
        if (premiumIdle) {
            return premiumIdle;
        }

        // Among available keys, pick the one with longest idle time
        // (this naturally distributes load and minimizes wait time)
        const sorted = [...available].sort((a, b) => {
            const idleA = now - a.lastRequestTime;
            const idleB = now - b.lastRequestTime;
            return idleB - idleA; // longest idle first
        });

        // Warn if approaching daily limit on the selected key
        const selected = sorted[0];
        if (!selected.isPremium && selected.dailyCount >= FREE_DAILY_LIMIT_WARNING) {
            console.warn(`⚠️ [Key Pool] ${selected.label}: ${selected.dailyCount}/${selected.dailyLimit} daily requests used`);
        }

        return selected;
    }

    /**
     * Wait for a key's rate limit window to clear.
     * This is called AFTER acquireKey() and uses the key's per-key mutex
     * to ensure sequential requests on the same key.
     */
    async waitForRateLimit(key: ManagedKey): Promise<void> {
        const now = Date.now();
        const timeSinceLastRequest = now - key.lastRequestTime;

        if (timeSinceLastRequest < key.rateLimitDelay) {
            const waitTime = key.rateLimitDelay - timeSinceLastRequest;
            console.log(`⏳ [Key Pool] ${key.label}: rate limiting, waiting ${Math.round(waitTime / 1000)}s`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        key.lastRequestTime = Date.now();
    }

    /**
     * Mark a key as exhausted (server-side daily limit reached).
     * This is called when Alpha Vantage returns a daily-limit Information
     * response, meaning their server considers this key used up even if
     * our local counter disagrees (timezone mismatch, etc).
     */
    markExhausted(key: ManagedKey): void {
        key.dailyCount = key.dailyLimit;
        console.warn(`🚫 [Key Pool] ${key.label}: marked as EXHAUSTED (server-side daily limit reached)`);
    }

    /**
     * Record a successful API call on a key.
     */
    recordSuccess(key: ManagedKey): void {
        key.dailyCount++;
        const limitStr = key.isPremium ? '∞' : String(key.dailyLimit);
        console.log(`📊 [Key Pool] ${key.label}: request successful (${key.dailyCount}/${limitStr} daily)`);
    }

    /**
     * Get pool usage statistics.
     */
    getPoolStats(): PoolStats {
        // Reset counters before reporting
        for (const key of this.keys) {
            this.checkAndResetKey(key);
        }

        const premiumKeys = this.keys.filter(k => k.isPremium);
        const freeKeys = this.keys.filter(k => !k.isPremium);
        const hasPremium = premiumKeys.length > 0;

        return {
            totalKeys: this.keys.length,
            premiumKeys: premiumKeys.length,
            freeKeys: freeKeys.length,
            keys: this.keys.map(k => ({
                label: k.label,
                isPremium: k.isPremium,
                dailyUsed: k.dailyCount,
                dailyLimit: k.isPremium ? 'unlimited' : k.dailyLimit,
                available: k.dailyCount < k.dailyLimit,
            })),
            totalDailyUsed: this.keys.reduce((sum, k) => sum + k.dailyCount, 0),
            totalDailyLimit: hasPremium
                ? 'unlimited'
                : freeKeys.reduce((sum, k) => sum + k.dailyLimit, 0),
        };
    }
}

// ─────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────

let poolInstance: ApiKeyPool | null = null;

export function getKeyPool(): ApiKeyPool {
    if (!poolInstance) {
        poolInstance = new ApiKeyPool();
    }
    return poolInstance;
}
