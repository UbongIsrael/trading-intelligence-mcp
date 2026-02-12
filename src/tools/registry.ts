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
 * Populate the tool registry (run once at startup)
 * Fills the toolRegistry array with all tool definitions
 */
export async function populateToolRegistry(): Promise<void> {
  if (toolRegistry.length > 0) {
    console.log(`📊 Tool registry already populated (${toolRegistry.length} tools)`);
    return; // Already populated, skip
  }

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
}

/**
 * Set up ListTools and CallTool handlers on a Server instance
 * Can be called multiple times for different Server instances
 */
export function setupServerHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: toolRegistry.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }))
    };
  });

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

/**
 * Register all MCP tools (convenience wrapper)
 * Populates the registry AND sets up handlers on the given server
 */
export async function registerTools(server: Server): Promise<void> {
  await populateToolRegistry();
  setupServerHandlers(server);
}


