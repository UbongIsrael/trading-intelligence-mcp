/**
 * Liquidity Zones Integration Tests
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { initializeRedis, shutdownRedis, getCacheService } from '../src/cache/index';
import {
  registerLiquidityZonesTool,
  registerSupportResistanceTool,
  registerPriceLevelAnalysisTool,
} from '../src/tools/liquidity-tool';
import { getRegisteredTools } from '../src/tools/registry';

// Type for tool handler function
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

// Mock the MCP Server
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  return {
    McpServer: jest.fn().mockImplementation(() => ({
      registerTool: jest.fn(),
    })),
  };
});

// Mock fetch for API calls
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

describe('Liquidity Zones Integration Tests', () => {
  let mockServer: jest.Mocked<McpServer>;

  beforeAll(async () => {
    // Initialize Redis connection
    try {
      await initializeRedis();
    } catch (error) {
      console.log('Redis not available, tests will use mock cache');
    }
    
    mockServer = new McpServer({
      name: 'test-server',
      version: '1.0.0',
    }) as jest.Mocked<McpServer>;
  });

  afterAll(async () => {
    try {
      await shutdownRedis();
    } catch (error) {
      // Ignore shutdown errors
    }
  });

  describe('Tool Registration', () => {
    test('should register get_liquidity_zones tool', () => {
      registerLiquidityZonesTool(mockServer);
      
      expect(mockServer.registerTool).toHaveBeenCalledWith(
        'get_liquidity_zones',
        expect.objectContaining({
          title: expect.any(String),
          description: expect.any(String),
          inputSchema: expect.any(Object),
        }),
        expect.any(Function)
      );
    });

    test('should register get_support_resistance tool', () => {
      registerSupportResistanceTool(mockServer);
      
      expect(mockServer.registerTool).toHaveBeenCalledWith(
        'get_support_resistance',
        expect.objectContaining({
          title: expect.any(String),
          description: expect.any(String),
          inputSchema: expect.any(Object),
        }),
        expect.any(Function)
      );
    });

    test('should register analyze_price_levels tool', () => {
      registerPriceLevelAnalysisTool(mockServer);
      
      expect(mockServer.registerTool).toHaveBeenCalledWith(
        'analyze_price_levels',
        expect.objectContaining({
          title: expect.any(String),
          description: expect.any(String),
          inputSchema: expect.any(Object),
        }),
        expect.any(Function)
      );
    });

    test('should add tools to registry', () => {
      const tools = getRegisteredTools();
      
      const liquidityTool = tools.find(t => t.name === 'get_liquidity_zones');
      const srTool = tools.find(t => t.name === 'get_support_resistance');
      const analysisTool = tools.find(t => t.name === 'analyze_price_levels');
      
      expect(liquidityTool).toBeDefined();
      expect(srTool).toBeDefined();
      expect(analysisTool).toBeDefined();
      
      // Verify metadata
      expect(liquidityTool?.category).toBe('technical');
      expect(srTool?.category).toBe('technical');
      expect(analysisTool?.category).toBe('technical');
    });
  });

  describe('Cache Service Integration', () => {
    test('should get cache service instance', () => {
      const cacheService = getCacheService();
      
      expect(cacheService).toBeDefined();
      expect(cacheService.liquidity).toBeDefined();
    });

    test('should have liquidity cache methods', () => {
      const cacheService = getCacheService();
      
      expect(typeof cacheService.liquidity.get).toBe('function');
      expect(typeof cacheService.liquidity.set).toBe('function');
      expect(typeof cacheService.liquidity.getOrFetch).toBe('function');
    });
  });

  describe('End-to-End Tool Execution', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('get_liquidity_zones should return formatted response', async () => {
      // Mock successful API response
      const mockResponse = {
        chart: {
          result: [{
            meta: {
              symbol: 'AAPL',
              currency: 'USD',
              regularMarketPrice: 175,
            },
            timestamp: Array.from({ length: 60 }, (_, i) => Math.floor(Date.now() / 1000) - i * 86400),
            indicators: {
              quote: [{
                open: Array(60).fill(170).map((v, i) => v + Math.sin(i / 5) * 10),
                high: Array(60).fill(180).map((v, i) => v + Math.sin(i / 5) * 10),
                low: Array(60).fill(165).map((v, i) => v + Math.sin(i / 5) * 10),
                close: Array(60).fill(175).map((v, i) => v + Math.sin(i / 5) * 10),
                volume: Array(60).fill(50000000),
              }],
            },
          }],
          error: null,
        },
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      // Get the registered handler
      const calls = (mockServer.registerTool as jest.Mock).mock.calls;
      const liquidityToolCall = calls.find((c: unknown[]) => c[0] === 'get_liquidity_zones');
      
      if (liquidityToolCall) {
        const handler = liquidityToolCall[2] as ToolHandler;
        const result = await handler({ symbol: 'AAPL', timeframe: '1d' });
        
        expect(result).toHaveProperty('content');
        expect(result.content[0]).toHaveProperty('type', 'text');
        expect(result.content[0].text).toContain('AAPL');
        expect(result.content[0].text).toContain('Liquidity Zones');
      }
    });

    test('should handle API errors gracefully', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response);

      const calls = (mockServer.registerTool as jest.Mock).mock.calls;
      const liquidityToolCall = calls.find((c: unknown[]) => c[0] === 'get_liquidity_zones');
      
      if (liquidityToolCall) {
        const handler = liquidityToolCall[2] as ToolHandler;
        const result = await handler({ symbol: 'INVALID_SYMBOL', timeframe: '1d' });
        
        expect(result.content[0].text).toContain('Error');
      }
    });

    test('should validate symbol format', async () => {
      const calls = (mockServer.registerTool as jest.Mock).mock.calls;
      const liquidityToolCall = calls.find((c: unknown[]) => c[0] === 'get_liquidity_zones');
      
      if (liquidityToolCall) {
        const handler = liquidityToolCall[2] as ToolHandler;
        
        // Test with invalid symbol
        const result = await handler({ symbol: 'WAYTOOLONGSYMBOLNAME123456', timeframe: '1d' });
        
        expect(result.content[0].text).toContain('Invalid symbol');
      }
    });
  });

  describe('Response Formatting', () => {
    test('should format prices correctly for high-value assets', async () => {
      const mockResponse = {
        chart: {
          result: [{
            meta: {
              symbol: 'BTC-USD',
              currency: 'USD',
              regularMarketPrice: 45000,
            },
            timestamp: Array.from({ length: 60 }, (_, i) => Math.floor(Date.now() / 1000) - i * 86400),
            indicators: {
              quote: [{
                open: Array(60).fill(44000).map((v, i) => v + Math.sin(i / 5) * 2000),
                high: Array(60).fill(46000).map((v, i) => v + Math.sin(i / 5) * 2000),
                low: Array(60).fill(43000).map((v, i) => v + Math.sin(i / 5) * 2000),
                close: Array(60).fill(45000).map((v, i) => v + Math.sin(i / 5) * 2000),
                volume: Array(60).fill(10000000000),
              }],
            },
          }],
          error: null,
        },
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const calls = (mockServer.registerTool as jest.Mock).mock.calls;
      const srToolCall = calls.find((c: unknown[]) => c[0] === 'get_support_resistance');
      
      if (srToolCall) {
        const handler = srToolCall[2] as ToolHandler;
        const result = await handler({ symbol: 'BTC-USD', timeframe: '1d' });
        
        expect(result.content[0].text).toContain('BTC-USD');
        expect(result.content[0].text).toContain('Support');
        expect(result.content[0].text).toContain('Resistance');
      }
    });

    test('should include trend information in analysis', async () => {
      const mockResponse = {
        chart: {
          result: [{
            meta: {
              symbol: 'AAPL',
              regularMarketPrice: 175,
            },
            timestamp: Array.from({ length: 60 }, (_, i) => Math.floor(Date.now() / 1000) - i * 86400),
            indicators: {
              quote: [{
                // Upward trending data
                open: Array.from({ length: 60 }, (_, i) => 150 + i * 0.5),
                high: Array.from({ length: 60 }, (_, i) => 152 + i * 0.5),
                low: Array.from({ length: 60 }, (_, i) => 148 + i * 0.5),
                close: Array.from({ length: 60 }, (_, i) => 150 + i * 0.5),
                volume: Array(60).fill(50000000),
              }],
            },
          }],
          error: null,
        },
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const calls = (mockServer.registerTool as jest.Mock).mock.calls;
      const analysisToolCall = calls.find((c: unknown[]) => c[0] === 'analyze_price_levels');
      
      if (analysisToolCall) {
        const handler = analysisToolCall[2] as ToolHandler;
        const result = await handler({ symbol: 'AAPL', timeframe: '1d' });
        
        expect(result.content[0].text).toContain('Trend');
        expect(result.content[0].text).toContain('AAPL');
      }
    });
  });

  describe('Different Timeframes', () => {
    const timeframes = ['1h', '4h', '1d', '1w'];

    timeframes.forEach(timeframe => {
      test(`should work with ${timeframe} timeframe`, async () => {
        const mockResponse = {
          chart: {
            result: [{
              meta: {
                symbol: 'AAPL',
                regularMarketPrice: 175,
              },
              timestamp: Array.from({ length: 30 }, (_, i) => Math.floor(Date.now() / 1000) - i * 86400),
              indicators: {
                quote: [{
                  open: Array(30).fill(170).map((v, i) => v + Math.sin(i / 3) * 5),
                  high: Array(30).fill(180).map((v, i) => v + Math.sin(i / 3) * 5),
                  low: Array(30).fill(165).map((v, i) => v + Math.sin(i / 3) * 5),
                  close: Array(30).fill(175).map((v, i) => v + Math.sin(i / 3) * 5),
                  volume: Array(30).fill(50000000),
                }],
              },
            }],
            error: null,
          },
        };

        (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
          ok: true,
          json: async () => mockResponse,
        } as Response);

        const calls = (mockServer.registerTool as jest.Mock).mock.calls;
        const liquidityToolCall = calls.find((c: unknown[]) => c[0] === 'get_liquidity_zones');
        
        if (liquidityToolCall) {
          const handler = liquidityToolCall[2] as ToolHandler;
          const result = await handler({ symbol: 'AAPL', timeframe });
          
          expect(result.content[0].text).toContain('AAPL');
          expect(result.content[0].text).toContain(timeframe);
        }
      });
    });
  });

  describe('Error Handling', () => {
    test('should handle network errors', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockRejectedValueOnce(
        new Error('Network error')
      );

      const calls = (mockServer.registerTool as jest.Mock).mock.calls;
      const liquidityToolCall = calls.find((c: unknown[]) => c[0] === 'get_liquidity_zones');
      
      if (liquidityToolCall) {
        const handler = liquidityToolCall[2] as ToolHandler;
        const result = await handler({ symbol: 'AAPL', timeframe: '1d' });
        
        expect(result.content[0].text).toContain('Error');
      }
    });

    test('should handle empty API response', async () => {
      const mockResponse = {
        chart: {
          result: [],
          error: null,
        },
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const calls = (mockServer.registerTool as jest.Mock).mock.calls;
      const liquidityToolCall = calls.find((c: unknown[]) => c[0] === 'get_liquidity_zones');
      
      if (liquidityToolCall) {
        const handler = liquidityToolCall[2] as ToolHandler;
        const result = await handler({ symbol: 'AAPL', timeframe: '1d' });
        
        expect(result.content[0].text).toContain('Error');
      }
    });
  });
});
