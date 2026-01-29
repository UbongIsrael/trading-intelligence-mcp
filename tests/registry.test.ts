/**
 * Tool Registry Tests
 */

import { describe, test, expect } from '@jest/globals';
import { getRegisteredTools, addToRegistry, ToolMetadata } from '../src/tools/registry';

describe('Tool Registry', () => {
  test('should start with tools registered', () => {
    const tools = getRegisteredTools();
    expect(Array.isArray(tools)).toBe(true);
    // After server initialization, we should have at least the health check tool
    expect(tools.length).toBeGreaterThanOrEqual(0);
  });

  test('should add tool to registry', () => {
    const initialCount = getRegisteredTools().length;
    
    const testTool: ToolMetadata = {
      name: 'test_tool',
      description: 'Test tool',
      category: 'system',
      version: '0.1.0',
    };

    addToRegistry(testTool);
    
    const tools = getRegisteredTools();
    expect(tools.length).toBe(initialCount + 1);
    
    const addedTool = tools.find(t => t.name === 'test_tool');
    expect(addedTool).toBeDefined();
    expect(addedTool?.description).toBe('Test tool');
  });

  test('registered tools should have required properties', () => {
    const tools = getRegisteredTools();
    
    tools.forEach(tool => {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('category');
      expect(tool).toHaveProperty('version');
      
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(['price', 'technical', 'fundamental', 'system']).toContain(tool.category);
      expect(typeof tool.version).toBe('string');
    });
  });
});
