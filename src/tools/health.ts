/**
 * Health Check Tool
 * Provides system health and diagnostic information
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { addToRegistry } from './registry.js';
import { config } from '../config.js';
import { getCacheService } from '../cache/index.js';

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
        detailed: z.boolean()
          .optional()
          .describe('Include detailed diagnostic information'),
      },
    },
    async ({ detailed = false }) => {
      const healthData = await getHealthData(detailed);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(healthData, null, 2),
          },
        ],
        structuredContent: healthData,
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
async function getHealthData(detailed: boolean): Promise<any> {
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
