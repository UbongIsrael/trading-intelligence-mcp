/**
 * Redis Client Wrapper with Connection Pooling
 * Handles connection management, retry logic, health checks, and parallel operations
 */

import Redis, { RedisOptions } from 'ioredis';
import { config } from '../config.js';
import { CacheError } from '../types.js';
import { recordRedisConnectionState, recordRedisError, getRedisMetrics, type RedisMetrics } from './metrics.js';

/**
 * Connection state enum for race condition prevention
 */
enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  FAILED = 'failed'
}

interface RedisClientOptions {
  maxRetries?: number;
  retryDelay?: number;
  connectionTimeout?: number;
  enableOfflineQueue?: boolean;
  poolSize?: number;  // NEW: Connection pool size
}

// Default pool size - 10 connections for parallel operations
const DEFAULT_POOL_SIZE = 10;

export class RedisClient {
  // Connection pool instead of single client
  private pool: Redis[] = [];
  private poolSize: number;
  private currentIndex: number = 0;

  private isConnected: boolean = false;
  private connectionAttempts: number = 0;
  private maxRetries: number;
  private retryDelay: number;
  private lastError: Error | null = null;

  // Connection state management for race condition prevention
  private connectionState: ConnectionState = ConnectionState.DISCONNECTED;
  private connectionPromise: Promise<void> | null = null;

  constructor(options: RedisClientOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelay = options.retryDelay ?? 1000;
    this.poolSize = options.poolSize ?? DEFAULT_POOL_SIZE;
  }

  /**
   * Initialize Redis connection pool
   * Uses connection state management to prevent race conditions
   */
  async connect(): Promise<void> {
    // If already connected, return immediately
    if (this.connectionState === ConnectionState.CONNECTED && this.pool.length > 0) {
      return;
    }

    // If connection in progress, wait for existing promise (prevents race condition)
    if (this.connectionState === ConnectionState.CONNECTING && this.connectionPromise) {
      console.log('⏳ Waiting for existing connection pool...');
      return this.connectionPromise;
    }

    // Start new connection - set state to CONNECTING
    this.connectionState = ConnectionState.CONNECTING;
    recordRedisConnectionState('connecting');
    this.connectionPromise = this._createPool();

    try {
      await this.connectionPromise;
      this.connectionState = ConnectionState.CONNECTED;
      recordRedisConnectionState('connected');
    } catch (error) {
      this.connectionState = ConnectionState.FAILED;
      this.connectionPromise = null;
      recordRedisConnectionState('failed');
      recordRedisError(error as Error);
      throw error;
    }
  }

  /**
   * Create the connection pool
   */
  private async _createPool(): Promise<void> {
    console.log(`📊 Creating Redis connection pool (${this.poolSize} connections)...`);

    try {
      const connectionPromises: Promise<Redis>[] = [];

      for (let i = 0; i < this.poolSize; i++) {
        connectionPromises.push(this._createConnection(i));
      }

      this.pool = await Promise.all(connectionPromises);
      this.isConnected = true;
      this.connectionAttempts = 0;
      this.lastError = null;

      console.log(`✅ Redis connection pool ready (${this.pool.length} connections)`);
    } catch (error) {
      this.lastError = error as Error;
      this.connectionAttempts++;
      console.error('❌ Redis pool creation failed:', error);
      throw new CacheError('Failed to create Redis connection pool', { error });
    }
  }

  /**
   * Create a single connection for the pool
   */
  private async _createConnection(index: number): Promise<Redis> {
    const redisUrl = config.redis.url;
    const isUpstashHttps = redisUrl.startsWith('https://') || redisUrl.startsWith('http://');
    const isRedisTLS = redisUrl.startsWith('rediss://');

    let redisOptions: RedisOptions;

    if (isUpstashHttps) {
      // Upstash HTTPS configuration (HTTP-based Redis protocol)
      const url = new URL(redisUrl);
      redisOptions = {
        host: url.hostname,
        port: url.port ? parseInt(url.port) : 443,
        password: config.redis.password,
        tls: redisUrl.startsWith('https://') ? {} : undefined,
        retryStrategy: (times: number) => {
          if (times > this.maxRetries) {
            return null; // Stop retrying
          }
          return Math.min(times * this.retryDelay, 10000);
        },
        enableOfflineQueue: false,
        maxRetriesPerRequest: 3,
        connectTimeout: 15000, // Increased for cloud Redis reliability
        lazyConnect: false,
      };
    } else {
      // Standard Redis configuration (redis:// or rediss://)
      redisOptions = {
        retryStrategy: (times: number) => {
          if (times > this.maxRetries) {
            return null;
          }
          return Math.min(times * this.retryDelay, 10000);
        },
        enableOfflineQueue: false,
        maxRetriesPerRequest: 3,
        connectTimeout: 15000, // Increased for reliability
        lazyConnect: false,
      };

      // For rediss://, enable TLS
      if (isRedisTLS) {
        redisOptions.tls = {
          rejectUnauthorized: false, // Allow self-signed certs for cloud Redis
        };
      }

      if (config.redis.password) {
        redisOptions.password = config.redis.password;
      }
    }

    // Create client - ioredis can parse rediss:// URLs directly
    const client = isUpstashHttps
      ? new Redis(redisOptions)
      : new Redis(config.redis.url, redisOptions);

    // Set up event handlers for this connection
    this._setupConnectionHandlers(client, index);

    // Wait for connection to be ready
    await this._waitForConnectionReady(client, index);

    return client;
  }

  /**
   * Wait for a single connection to be ready
   */
  private async _waitForConnectionReady(client: Redis, index: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Redis connection ${index} timeout`));
      }, 15000); // 15s timeout for cloud Redis reliability

      client.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });

      client.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Set up event handlers for a pool connection
   */
  private _setupConnectionHandlers(client: Redis, index: number): void {
    client.on('error', (error) => {
      console.error(`❌ Redis pool[${index}] error:`, error.message);
      this.lastError = error;
    });

    client.on('close', () => {
      console.log(`🔌 Redis pool[${index}] closed`);
    });

    client.on('reconnecting', (delay: number) => {
      console.log(`🔄 Redis pool[${index}] reconnecting in ${delay}ms...`);
    });
  }

  /**
   * Get a client from the pool (round-robin distribution)
   * This enables parallel operations across multiple connections
   */
  getClient(): Redis {
    if (this.pool.length === 0 || !this.isConnected) {
      throw new CacheError('Redis client not connected');
    }

    const client = this.pool[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.pool.length;

    return client;
  }

  /**
   * Get pool statistics
   */
  getPoolStats(): { poolSize: number; activeConnections: number; currentIndex: number } {
    return {
      poolSize: this.poolSize,
      activeConnections: this.pool.length,
      currentIndex: this.currentIndex,
    };
  }

  /**
   * Check if Redis is connected and healthy
   */
  async healthCheck(): Promise<{
    connected: boolean;
    latency?: number;
    error?: string;
    connectionAttempts: number;
    poolSize?: number;
  }> {
    if (this.pool.length === 0) {
      return {
        connected: false,
        error: 'Redis pool not initialized',
        connectionAttempts: this.connectionAttempts,
      };
    }

    try {
      // Ping using first connection in pool
      const start = Date.now();
      await this.pool[0].ping();
      const latency = Date.now() - start;

      return {
        connected: true,
        latency,
        connectionAttempts: this.connectionAttempts,
        poolSize: this.pool.length,
      };
    } catch (error) {
      return {
        connected: false,
        error: (error as Error).message,
        connectionAttempts: this.connectionAttempts,
        poolSize: this.pool.length,
      };
    }
  }

  /**
   * Get connection status
   */
  isHealthy(): boolean {
    return this.isConnected && this.pool.length > 0;
  }

  /**
   * Get Redis metrics for production monitoring
   */
  getMetrics(): RedisMetrics {
    return getRedisMetrics();
  }

  /**
   * Get last error if any
   */
  getLastError(): Error | null {
    return this.lastError;
  }

  /**
   * Gracefully disconnect all pool connections
   */
  async disconnect(): Promise<void> {
    if (this.pool.length > 0) {
      console.log(`🔌 Disconnecting ${this.pool.length} Redis connections...`);

      try {
        await Promise.all(this.pool.map(async (client, index) => {
          try {
            await client.quit();
          } catch (error) {
            console.error(`❌ Error disconnecting pool[${index}]:`, error);
            client.disconnect();
          }
        }));
        console.log('✅ Redis pool disconnected gracefully');
      } catch (error) {
        console.error('❌ Error during Redis pool disconnect:', error);
      } finally {
        this.pool = [];
        this.isConnected = false;
        this.connectionState = ConnectionState.DISCONNECTED;
        this.connectionPromise = null;
        this.currentIndex = 0;
      }
    }
  }

  /**
   * Force disconnect (for emergency situations)
   */
  forceDisconnect(): void {
    if (this.pool.length > 0) {
      this.pool.forEach((client, index) => {
        try {
          client.disconnect();
        } catch (error) {
          console.error(`❌ Error force disconnecting pool[${index}]:`, error);
        }
      });
      this.pool = [];
      this.isConnected = false;
      this.connectionState = ConnectionState.DISCONNECTED;
      this.connectionPromise = null;
      this.currentIndex = 0;
      console.log('🛑 Redis pool force disconnected');
    }
  }

  /**
   * Reset connection pool (disconnect and reconnect)
   */
  async reset(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }
}

// Singleton instance
let redisClientInstance: RedisClient | null = null;

/**
 * Get the singleton Redis client instance
 */
export function getRedisClient(): RedisClient {
  if (!redisClientInstance) {
    redisClientInstance = new RedisClient({
      poolSize: config.redis.poolSize,
    });
  }
  return redisClientInstance;
}

/**
 * Initialize Redis client (should be called on server startup)
 */
export async function initializeRedis(): Promise<RedisClient> {
  const client = getRedisClient();

  if (!config.features.enableCaching) {
    console.log('⚠️  Redis caching is disabled via configuration');
    return client;
  }

  await client.connect();
  return client;
}

/**
 * Shutdown Redis client (should be called on server shutdown)
 */
export async function shutdownRedis(): Promise<void> {
  if (redisClientInstance) {
    await redisClientInstance.disconnect();
    redisClientInstance = null;
  }
}
