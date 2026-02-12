/**
 * Tool Registry
 * Central registration point for all MCP tools
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

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
import { registerContextualFundamentalsTool } from './contextual-fundamentals-tool.js';
import { registerDCFAnalysisTool } from './dcf-tool.js';

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
/**
 * Tool definition interface
 */
export interface ToolDefinition {
  name: string;
  description: string;
  category: 'prices' | 'technical' | 'fundamental' | 'system';
  version: string;
  inputSchema: any;
  outputSchema?: any;
  handler: (args: any, extra?: any) => Promise<any>;
}

/**
 * Registry of all available tools
 */
const toolRegistry: ToolDefinition[] = [];

/**
 * Register a tool and add it to the registry
 */
export function registerTool(tool: ToolDefinition): void {
  toolRegistry.push(tool);
  console.log(`  ✓ Registered: ${tool.name} (${tool.category})`);
}

/**
 * Get all registered tools
 */
export function getRegisteredTools(): ToolDefinition[] {
  return [...toolRegistry];
}

/**
 * Register all MCP tools
 * This is the main entry point for tool registration
 */
/**
 * Register all MCP tools
 * Central entry point for tool registration
 */
export async function registerTools(server: Server): Promise<void> {
  // 1. Execute registration functions to populate the registry
  console.log('  Registering system tools...');
  await registerHealthCheckTool();

  console.log('  Registering price tools...');
  registerPriceTool();
  registerBatchPriceTool();
  registerInvalidatePriceTool();

  console.log('  Registering funding rate tools...');
  registerFundingRateTool();
  registerBatchFundingRatesTool();
  registerAllFundingRatesTool();
  registerFundingRateStatsTool();
  registerSupportedPerpetualsTool();

  console.log('  Registering fundamentals tools...');
  registerCompanyOverviewTool();
  registerEarningsTool();
  registerFinancialStatementsTool();
  registerFullFundamentalsTool();
  registerContextualFundamentalsTool();

  console.log('  Registering DCF analysis tools...');
  registerDCFAnalysisTool();

  console.log('  Registering liquidity zones tools...');
  registerLiquidityZonesTool();
  registerSupportResistanceTool();
  registerPriceLevelAnalysisTool();
  registerQuickSupportResistanceTool();
  registerAvailableTimeframesTool();

  console.log(`\n📊 Total tools registered: ${toolRegistry.length}`);

  // 2. Set up ListTools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: toolRegistry.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }))
    };
  });

  // 3. Set up CallTool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolRegistry.find(t => t.name === request.params.name);

    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${request.params.name}`);
    }

    try {
      const args = request.params.arguments || {};
      const result = await tool.handler(args);
      return result;
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  });
}


