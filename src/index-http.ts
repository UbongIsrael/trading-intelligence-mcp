/**
 * Trading Intelligence MCP Server - HTTP Entry Point
 * For Context Protocol deployment
 */

import { createHttpServer } from './http-server.js';

/**
 * Initialize and start the HTTP MCP server
 */
async function main() {
  try {
    const server = createHttpServer();
    await server.start();
    
    // Set up graceful shutdown handlers
    const shutdown = async () => {
      await server.shutdown();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
main();
