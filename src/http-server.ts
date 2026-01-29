/**
 * HTTP Server for Context Protocol Integration
 * Provides SSE and HTTP Streaming transports for MCP with security middleware
 */

import express, { Request, Response } from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createContextMiddleware } from '@ctxprotocol/sdk';
import { config, mcpMetadata, validateConfig, logConfigSummary } from './config.js';
import { registerTools } from './tools/registry.js';
import { initializeRedis, shutdownRedis } from './cache/index.js';

/**
 * HTTP-based MCP Server for Context Protocol
 * Implements Data Broker Standard with output schemas
 */
export class HttpMcpServer {
  private app: express.Application;
  private mcpServer: McpServer;
  private port: number;
  private server: any;

  constructor() {
    this.app = express();
    this.port = config.port;

    // Initialize MCP server
    this.mcpServer = new McpServer({
      name: mcpMetadata.name,
      version: mcpMetadata.version,
    });

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // CORS for Context Protocol
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });

    // JSON body parser
    this.app.use(express.json());

    // Request logging
    this.app.use((req, _res, next) => {
      console.log(`${req.method} ${req.path}`);
      next();
    });
  }

  /**
   * Setup routes for Context Protocol
   */
  private setupRoutes(): void {
    // Health check endpoint - No auth required
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'healthy',
        version: mcpMetadata.version,
        name: mcpMetadata.name,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    });

    // Root endpoint - show available endpoints
    this.app.get('/', (_req: Request, res: Response) => {
      res.json({
        name: mcpMetadata.name,
        version: mcpMetadata.version,
        description: mcpMetadata.description,
        endpoints: {
          health: '/health',
          sse: '/sse',
          mcp: '/mcp',
        },
        documentation: 'https://github.com/your-repo/trading-intelligence-mcp',
        dataBokerStandard: true, // Indicates output schemas are defined
        securityEnabled: true, // Context Protocol JWT authentication
      });
    });

    // SSE endpoint for Context Protocol - With authentication
    this.app.get('/sse', createContextMiddleware(), async (req: Request, res: Response) => {
      console.log('📡 New authenticated SSE connection from Context Protocol');

      try {
        // Create SSE transport
        const transport = new SSEServerTransport('/messages', res);

        // Connect MCP server to this transport
        await this.mcpServer.connect(transport);

        console.log('✅ SSE transport connected');

        // Handle client disconnect
        req.on('close', () => {
          console.log('📴 SSE client disconnected');
        });

      } catch (error) {
        console.error('❌ SSE connection error:', error);
        res.status(500).json({ error: 'Failed to establish SSE connection' });
      }
    });

    // Message endpoint for SSE transport - With authentication
    this.app.post('/messages', createContextMiddleware(), express.text({ type: '*/*' }), async (_req: Request, res: Response) => {
      console.log('📨 Received authenticated message via SSE transport');
      // The SSE transport handles this internally
      res.sendStatus(202);
    });

    // HTTP Streaming endpoint for Context Protocol - With authentication
    this.app.post('/mcp', createContextMiddleware(), async (req: Request, res: Response) => {
      console.log('📡 MCP HTTP Streaming request (authenticated)');

      try {
        // For HTTP streaming, we'll handle requests directly
        // This is a simplified implementation
        const request = req.body;

        // Set streaming headers
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Transfer-Encoding', 'chunked');

        // Process the MCP request
        // Note: Full HTTP streaming requires more complex implementation
        // For now, we'll send a response
        res.json({
          jsonrpc: '2.0',
          id: request.id || 1,
          result: { message: 'HTTP Streaming not fully implemented yet. Use /sse endpoint.' }
        });

      } catch (error) {
        console.error('❌ MCP streaming error:', error);
        res.status(500).json({
          jsonrpc: '2.0',
          id: req.body?.id || 1,
          error: { message: 'Internal server error' }
        });
      }
    });

    // 404 handler
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not Found',
        message: `Endpoint ${req.path} not found`,
        availableEndpoints: ['/', '/health', '/sse', '/mcp']
      });
    });
  }

  /**
   * Initialize MCP server and register tools
   */
  async initialize(): Promise<void> {
    try {
      console.log('🚀 Starting Trading Intelligence MCP Server...');
      console.log('');

      // Validate configuration
      validateConfig();
      logConfigSummary();
      console.log('');

      // Initialize Redis
      console.log('🔌 Initializing Redis connection...');
      try {
        await initializeRedis();
        console.log('✅ Redis initialized successfully');
      } catch (error) {
        console.warn('⚠️  Redis initialization failed, caching will be disabled:', (error as Error).message);
      }

      // Register all MCP tools with output schemas
      console.log('🔧 Registering MCP tools with Data Broker Standard...');
      await registerTools(this.mcpServer);
      console.log('✅ All tools registered with output schemas');
      console.log('');

    } catch (error) {
      console.error('❌ Failed to initialize server:', error);
      throw error;
    }
  }

  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    await this.initialize();

    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        console.log('🚀 HTTP MCP Server is running');
        console.log(`📡 Listening on port ${this.port}`);
        console.log('🔒 Context Protocol JWT authentication enabled');
        console.log('📊 Data Broker Standard compliant (output schemas defined)');
        console.log('');
        console.log('📊 Available Endpoints:');
        console.log(`   Health: http://localhost:${this.port}/health`);
        console.log(`   SSE:    http://localhost:${this.port}/sse (authenticated)`);
        console.log(`   MCP:    http://localhost:${this.port}/mcp (authenticated)`);
        console.log('');
        console.log('✨ Ready for Context Protocol requests');
        resolve();
      });
    });
  }

  /**
   * Shutdown server gracefully
   */
  async shutdown(): Promise<void> {
    console.log('\n👋 Shutting down server...');

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server.close(() => {
          console.log('✅ HTTP server closed');
          resolve();
        });
      });
    }

    try {
      await shutdownRedis();
      console.log('✅ Redis connections closed');
    } catch (error) {
      console.warn('⚠️  Error closing Redis:', (error as Error).message);
    }

    console.log('✅ Server shutdown complete');
  }
}

/**
 * Create and export server instance
 */
export const createHttpServer = (): HttpMcpServer => {
  return new HttpMcpServer();
};
