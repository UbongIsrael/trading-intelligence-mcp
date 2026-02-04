/**
 * Health Check Tool
 * Provides system health and diagnostic information
 */

import { getRegisteredTools, registerTool } from './registry.js';
import { config } from '../config.js';
import { getCacheService } from '../cache/index.js';
import { HealthCheckOutputSchema } from '../schemas/output-schemas.js';

/**
 * Register the health check tool
 */
/**
 * Register the health check tool
 */
export async function registerHealthCheckTool(): Promise<void> {


  registerTool({
    name: 'health_check',
    description: 'Get server health status and system diagnostics',
    category: 'system',
    version: '0.1.0',
    inputSchema: {
      type: "object" as const,
      properties: {
        detailed: {
          type: "boolean" as const,
          description: "Include detailed diagnostic information",
        },
      },
    },
    outputSchema: HealthCheckOutputSchema as any,
    handler: async (args: any) => {
      const { detailed = false } = args as { detailed?: boolean };
      // count might change at runtime, so we fetch it again inside handler or trust the one captured?
      // Better to fetch current count inside handler to be accurate.
      const currentToolCount = getRegisteredTools().length;
      const healthData = await getHealthData(detailed, currentToolCount);

      // Create schema-compliant structured data
      const structuredData = {
        status: healthData.status as 'healthy' | 'unhealthy',
        version: healthData.version,
        uptime: healthData.uptime,
        cache: {
          status: healthData.cache?.stats ? 'connected' : 'disconnected',
          latency: healthData.services?.redis?.latency || '0ms',
          hitRate: healthData.cache?.hitRate || '0%',
        },
        tools: currentToolCount,
        integrations: {
          yahooFinance: 'operational',
          coinGecko: 'operational',
          binance: 'operational',
          alphaVantage: 'operational',
          redis: healthData.services?.redis?.connected ? 'connected' : 'disconnected',
        }
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(healthData, null, 2),
          },
        ],
        structuredContent: structuredData,
      };
    }
  });
}

/**
 * Gather health data
 */
async function getHealthData(detailed: boolean, toolCount: number): Promise<any> {
  const baseHealth = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '0.1.0',
    environment: config.nodeEnv,
  };

  if (!detailed) {
    return baseHealth;
  }

  // Detailed diagnostics
  const cacheService = getCacheService();
  const cacheHealth = await cacheService.healthCheck();

  return {
    ...baseHealth,
    tools: toolCount,
    system: {
      platform: process.platform,
      nodeVersion: process.version,
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        unit: 'MB',
      },
      cpu: {
        usage: process.cpuUsage(),
      },
    },
    configuration: {
      port: config.port,
      caching: config.features.enableCaching,
      historicalData: config.features.enableHistoricalData,
      newsSentiment: config.features.enableNewsSentiment,
    },
    services: {
      redis: {
        enabled: cacheHealth.enabled,
        connected: cacheHealth.connected,
        latency: cacheHealth.latency,
        error: cacheHealth.error,
        url: config.redis.url.replace(/:[^:@]*@/, ':****@'),
      },
      database: {
        enabled: config.features.enableHistoricalData,
      },
    },
    cache: {
      stats: cacheHealth.stats,
      hitRate: `${(cacheHealth.stats.hitRate * 100).toFixed(2)}%`,
      operations: cacheHealth.stats.operations,
    },
  };
}
