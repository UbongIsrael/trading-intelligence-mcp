/**
 * Trading Intelligence MCP Server
 * Main entry point
 */

import { validateConfig, logConfigSummary } from './config.js';
import { createServer } from './server.js';

/**
 * Initialize and start the MCP server
 */
async function main() {
  try {
    console.log('🚀 Starting Trading Intelligence MCP Server...');
    console.log('');
    
    // Validate configuration
    validateConfig();
    logConfigSummary();
    console.log('');

    // Create and start the server
    const server = createServer();
    await server.start();
    
    // Set up graceful shutdown handlers
    const shutdown = async () => {
      await server.shutdown();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    
    // Log health status
    const health = server.getHealthStatus();
    console.log('\n📊 Server Health:');
    console.log(`   Status: ${health.status}`);
    console.log(`   Connected: ${health.connected}`);
    console.log(`   Version: ${health.metadata.version}`);
    console.log('');
    console.log('✨ Ready to receive MCP requests');
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
main();
