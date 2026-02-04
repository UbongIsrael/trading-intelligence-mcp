/**
 * Health Check Tool
 * Provides system health and diagnostic information
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { addToRegistry, getRegisteredTools } from './registry.js';
import { config } from '../config.js';
import { getCacheService } from '../cache/index.js';
import { HealthCheckOutputSchema } from '../schemas/output-schemas.js';

/**
 * Register the health check tool
 */
export function registerHealthCheckTool(server: McpServer): void {
  server.registerTool(
    'health_check',
    {
      title: 'Health Check',
      description: 'Get server health status and system diagnostics',
      inputSchema: {
        type: "object" as const,
        properties: {
          detailed: {
            type: "boolean" as const,
            description: "Include detailed diagnostic information",
          },
        },
      } as any,
      outputSchema: HealthCheckOutputSchema as any,
    },
    async (args: any) => {
      const { detailed = false } = args as { detailed?: boolean };
      const toolCount = getRegisteredTools().length;
      const healthData = await getHealthData(detailed, toolCount);

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
        tools: toolCount,
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
  );

  addToRegistry({
    name: 'health_check',
    description: 'System health and diagnostics',
    category: 'system',
    version: '0.1.0',
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
