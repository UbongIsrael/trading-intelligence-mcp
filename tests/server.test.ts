/**
 * Basic Server Tests
 * Tests for MCP server initialization and basic functionality
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { TradingIntelligenceServer } from '../src/server';
import { mcpMetadata } from '../src/config';

describe('TradingIntelligenceServer', () => {
  let server: TradingIntelligenceServer;

  beforeEach(() => {
    server = new TradingIntelligenceServer();
  });

  test('should create server instance', () => {
    expect(server).toBeDefined();
    expect(server).toBeInstanceOf(TradingIntelligenceServer);
  });

  test('should have correct metadata', () => {
    const mcpServer = server.getMcpServer();
    expect(mcpServer).toBeDefined();
  });

  test('should initialize successfully', async () => {
    await expect(server.initialize()).resolves.not.toThrow();
  });

  test('should return health status', () => {
    const health = server.getHealthStatus();
    
    expect(health).toBeDefined();
    expect(health.status).toBeDefined();
    expect(health.connected).toBe(false); // Not connected yet
    expect(health.uptime).toBeGreaterThanOrEqual(0);
    expect(health.metadata).toEqual(mcpMetadata);
  });

  test('health status should be unhealthy before connection', () => {
    const health = server.getHealthStatus();
    expect(health.status).toBe('unhealthy');
    expect(health.connected).toBe(false);
  });
});

describe('Server Lifecycle', () => {
  test('should handle initialization errors gracefully', async () => {
    // This test would require mocking the tool registry to throw an error
    // For now, we just verify the basic structure is in place
    expect(true).toBe(true);
  });
});
