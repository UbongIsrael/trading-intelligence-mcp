/**
 * HTTP Server for Context Protocol Integration
 * Uses StreamableHTTP transport as required by Context Protocol
 */

import { randomUUID } from 'node:crypto';
import express, { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createContextMiddleware } from '@ctxprotocol/sdk';
import { config, mcpMetadata, validateConfig, logConfigSummary } from './config.js';
import { populateToolRegistry, setupServerHandlers } from './tools/registry.js';
import { initializeRedis, shutdownRedis } from './cache/index.js';

/**
 * HTTP-based MCP Server for Context Protocol
 * Implements Data Broker Standard with StreamableHTTPServerTransport
 */
export class HttpMcpServer {
  private app: express.Application;
  private port: number;
  private server: any;
  private transports: Record<string, StreamableHTTPServerTransport> = {};

  constructor() {
    this.app = express();
    this.port = config.port;

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
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');

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
      console.log(`${req.method} ${req.path} ${req.headers['mcp-session-id'] ? `[Session: ${req.headers['mcp-session-id']}]` : ''}`);
      next();
    });
  }

  /**
   * Setup routes for Context Protocol
   */
  private setupRoutes(): void {
    // Create Context Protocol security middleware
    const verifyContextAuth = createContextMiddleware();

    // Health check endpoint - No auth required
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'healthy',
        version: mcpMetadata.version,
        name: mcpMetadata.name,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        transport: 'StreamableHTTP',
        dataBokerStandard: true,
        securityEnabled: true,
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
          mcp: '/mcp (POST & GET)',
        },
        transport: 'StreamableHTTP',
        documentation: 'https://github.com/your-repo/trading-intelligence-mcp',
        dataBokerStandard: true,
        securityEnabled: true,
      });
    });

    // MCP endpoint (POST) - With authentication
    // This is the main endpoint Context Protocol uses
    this.app.post('/mcp', verifyContextAuth, async (req: Request, res: Response) => {
      console.log('📡 MCP POST request (authenticated)');

      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && this.transports[sessionId]) {
          // Use existing session
          transport = this.transports[sessionId];
          console.log(`🔄 Using existing session: ${sessionId}`);
        } else if (!sessionId && isInitializeRequest(req.body)) {
          // Create new session with its own Server instance
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              this.transports[id] = transport;
              console.log(`✅ New session initialized: ${id}`);
            },
          });

          // Each session gets its own Server instance to avoid
          // "Already connected to a transport" errors
          const sessionServer = new Server(
            {
              name: mcpMetadata.name,
              version: mcpMetadata.version,
            },
            {
              capabilities: {
                tools: { listChanged: true },
                resources: {},
                prompts: {},
              },
            }
          );

          // Wire up tool handlers on this session's server
          setupServerHandlers(sessionServer);
          await sessionServer.connect(transport);
        } else {
          console.error('❌ Invalid session - no session ID and not initialize request');
          res.status(400).json({ error: 'Invalid session' });
          return;
        }

        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('❌ MCP POST error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    });

    // MCP endpoint (GET) - With authentication
    // Used for long-polling by Context Protocol
    this.app.get('/mcp', verifyContextAuth, async (req: Request, res: Response) => {
      console.log('📡 MCP GET request (authenticated) - long polling');

      try {
        const sessionId = req.headers['mcp-session-id'] as string;
        const transport = this.transports[sessionId];

        if (transport) {
          await transport.handleRequest(req, res);
        } else {
          console.error(`❌ Invalid session ID: ${sessionId}`);
          res.status(400).json({ error: 'Invalid session' });
        }
      } catch (error) {
        console.error('❌ MCP GET error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    });

    // 404 handler
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not Found',
        message: `Endpoint ${req.path} not found`,
        availableEndpoints: ['/', '/health', '/mcp']
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

      // Register all MCP tools (populate registry only - handlers are set up per-session)
      console.log('🔧 Registering MCP tools with Data Broker Standard...');
      await populateToolRegistry();
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
        console.log('🚂 Using StreamableHTTP transport (required by Context Protocol)');
        console.log('📊 Data Broker Standard compliant (output schemas defined)');
        console.log('');
        console.log('📊 Available Endpoints:');
        console.log(`   Health: http://localhost:${this.port}/health (no auth)`);
        console.log(`   MCP:    http://localhost:${this.port}/mcp (POST & GET, authenticated)`);
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

    // Close all active transports
    for (const sessionId in this.transports) {
      try {
        await this.transports[sessionId].close();
        console.log(`✅ Closed session: ${sessionId}`);
      } catch (error) {
        console.warn(`⚠️  Error closing session ${sessionId}:`, (error as Error).message);
      }
    }

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
