/**
 * Tool Registry
 * Central registration point for all MCP tools
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { registerHealthCheckTool } from './health.js';
import { registerPriceTool, registerBatchPriceTool, registerInvalidatePriceTool } from './price-tool.js';
import {
  registerFundingRateTool,
  registerBatchFundingRatesTool,
  registerAllFundingRatesTool,
  registerFundingRateStatsTool,
  registerSupportedPerpetualsTool,
} from './funding-tool.js';
import {
  registerCompanyOverviewTool,
  registerEarningsTool,
  registerFinancialStatementsTool,
  registerFullFundamentalsTool,
} from './fundamentals-tool.js';
import {
  registerLiquidityZonesTool,
  registerSupportResistanceTool,
  registerPriceLevelAnalysisTool,
  registerQuickSupportResistanceTool,
  registerAvailableTimeframesTool,
} from './liquidity-tool.js';

/**
 * Tool metadata interface
 */
export interface ToolMetadata {
  name: string;
  description: string;
  category: 'prices' | 'technical' | 'fundamental' | 'system';
  version: string;
}

/**
 * Registry of all available tools
 */
const toolRegistry: ToolMetadata[] = [];

/**
 * Register a tool and add it to the registry
 */
export function addToRegistry(metadata: ToolMetadata): void {
  toolRegistry.push(metadata);
  console.log(`  ✓ Registered: ${metadata.name} (${metadata.category})`);
}

/**
 * Get all registered tools
 */
export function getRegisteredTools(): ToolMetadata[] {
  return [...toolRegistry];
}

/**
 * Register all MCP tools
 * This is the main entry point for tool registration
 */
export async function registerTools(server: McpServer): Promise<void> {
  try {
    // System tools
    console.log('  Registering system tools...');
    await registerHealthCheckTool(server);
    
    // Price aggregation tools
    console.log('  Registering price tools...');
    registerPriceTool(server);
    registerBatchPriceTool(server);
    registerInvalidatePriceTool(server);
    
    // Funding rate tools
    console.log('  Registering funding rate tools...');
    registerFundingRateTool(server);
    registerBatchFundingRatesTool(server);
    registerAllFundingRatesTool(server);
    registerFundingRateStatsTool(server);
    registerSupportedPerpetualsTool(server);
    
    // Fundamental data tools
    console.log('  Registering fundamentals tools...');
    registerCompanyOverviewTool(server);
    registerEarningsTool(server);
    registerFinancialStatementsTool(server);
    registerFullFundamentalsTool(server);
    
    // Liquidity zones / Technical analysis tools
    console.log('  Registering liquidity zones tools...');
    registerLiquidityZonesTool(server);
    registerSupportResistanceTool(server);
    registerPriceLevelAnalysisTool(server);
    registerQuickSupportResistanceTool(server);
    registerAvailableTimeframesTool(server);
    
    // Future tool categories will be added here:
    // - News & sentiment tools (Wave 5)
    
    console.log(`\n📊 Total tools registered: ${toolRegistry.length}`);
    
  } catch (error) {
    console.error('Failed to register tools:', error);
    throw error;
  }
}

/**
 * Example tool registration helper
 * This demonstrates the pattern for registering tools
 */
export function registerExampleTool(server: McpServer): void {
  server.registerTool(
    'example_tool',
    {
      title: 'Example Tool',
      description: 'An example tool demonstrating the registration pattern',
      inputSchema: {
        text: z.string().describe('Example text input'),
      },
    },
    async ({ text }) => {
      return {
        content: [
          {
            type: 'text',
            text: `Echo: ${text}`,
          },
        ],
      };
    }
  );

  addToRegistry({
    name: 'example_tool',
    description: 'Example tool for demonstration',
    category: 'system',
    version: '0.1.0',
  });
}
