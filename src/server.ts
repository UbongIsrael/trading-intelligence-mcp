/**
 * MCP Server initialization and configuration
 * Implements the Model Context Protocol server using @modelcontextprotocol/sdk
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mcpMetadata } from './config.js';
import { registerTools } from './tools/registry.js';
import { MCPError } from './types.js';
import { initializeRedis, shutdownRedis } from './cache/index.js';

/**
 * Trading Intelligence MCP Server class
 * Manages server lifecycle, tool registration, and health checks
 */
export class TradingIntelligenceServer {
  private server: Server;
  private transport?: StdioServerTransport;
  private isConnected: boolean = false;

  constructor() {
    // Initialize MCP server with metadata
    this.server = new Server(
      {
        name: mcpMetadata.name,
        version: mcpMetadata.version,
      },
      {
        capabilities: {
          tools: {
            listChanged: true
          },
          resources: {},
          prompts: {},
        },
      }
    );

    console.log(`📡 Initializing ${mcpMetadata.name} v${mcpMetadata.version}`);
  }

  /**
   * Initialize the server and register all tools
   */
  async initialize(): Promise<void> {
    try {
      // Initialize Redis connection pool first
      console.log('🔌 Initializing Redis connection...');
      try {
        await initializeRedis();
        console.log('✅ Redis initialized successfully');
      } catch (error) {
        console.warn('⚠️  Redis initialization failed, caching will be disabled:', (error as Error).message);
        // Continue without Redis - services will gracefully degrade
      }

      console.log('🔧 Registering MCP tools...');

      // Register all tools from the registry
      await registerTools(this.server);

      console.log('✅ All tools registered successfully');
    } catch (error) {
      console.error('❌ Failed to initialize server:', error);
      throw new MCPError(
        'INITIALIZATION_ERROR',
        'Failed to initialize MCP server',
        { error }
      );
    }
  }

  /**
   * Connect the server to stdio transport
   */
  async connect(): Promise<void> {
    try {
      if (this.isConnected) {
        console.warn('⚠️  Server already connected');
        return;
      }

      console.log('🔌 Connecting to stdio transport...');

      // Create stdio transport for communication
      this.transport = new StdioServerTransport();

      // Connect the server to the transport
      await this.server.connect(this.transport);

      this.isConnected = true;
      console.log('✅ Server connected successfully');

    } catch (error) {
      console.error('❌ Failed to connect server:', error);
      throw new MCPError(
        'CONNECTION_ERROR',
        'Failed to connect to transport',
        { error }
      );
    }
  }

  /**
   * Start the server (initialize + connect)
   */
  async start(): Promise<void> {
    await this.initialize();
    await this.connect();
    console.log('🚀 Trading Intelligence MCP Server is running');
  }

  /**
   * Gracefully shutdown the server
   */
  async shutdown(): Promise<void> {
    try {
      console.log('\n👋 Shutting down server...');

      if (this.transport) {
        // Close transport connection
        await this.transport.close();
        this.isConnected = false;
        console.log('✅ Transport closed');
      }

      // Shutdown Redis connections
      try {
        await shutdownRedis();
        console.log('✅ Redis connections closed');
      } catch (error) {
        console.warn('⚠️  Error closing Redis:', (error as Error).message);
      }

      console.log('✅ Server shutdown complete');
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      throw error;
    }
  }

  /**
   * Health check for the server
   */
  getHealthStatus(): {
    status: 'healthy' | 'unhealthy';
    connected: boolean;
    uptime: number;
    metadata: typeof mcpMetadata;
  } {
    return {
      status: this.isConnected ? 'healthy' : 'unhealthy',
      connected: this.isConnected,
      uptime: process.uptime(),
      metadata: mcpMetadata,
    };
  }

  /**
   * Get the underlying MCP server instance
   */
  getMcpServer(): Server {
    return this.server;
  }
}

/**
 * Create and export a singleton instance
 */
export const createServer = (): TradingIntelligenceServer => {
  return new TradingIntelligenceServer();
};
