
import { getPriceSafe } from '../src/services/prices.js';
import { fetchCompanyOverview, fetchEarnings } from '../src/services/fundamentals-alphavantage.js';
import { Mutex } from '../src/utils/mutex.js';

console.log('Starting verification...');

// Test 1: Mutex integrity
async function testMutex() {
    console.log('Testing Mutex...');
    const mutex = new Mutex();
    const start = Date.now();

    await Promise.all([
        mutex.dispatch(async () => {
            console.log('Task 1 start');
            await new Promise(r => setTimeout(r, 100));
            console.log('Task 1 end');
        }),
        mutex.dispatch(async () => {
            console.log('Task 2 start');
            await new Promise(r => setTimeout(r, 100));
            console.log('Task 2 end');
        })
    ]);

    const duration = Date.now() - start;
    if (duration < 200) {
        console.error('❌ Mutex failed to serialize tasks');
    } else {
        console.log('✅ Mutex working correctly');
    }
}

// Test 2: Imports (if this runs, Zod imports are likely fine)
async function testImports() {
    console.log('Testing Imports...');
    try {
        // Just checking if we can import these without error
        const { registerPriceTool } = await import('../src/tools/price-tool.js');
        const { registerLiquidityZonesTool } = await import('../src/tools/liquidity-tool.js');
        const { registerContextualFundamentalsTool } = await import('../src/tools/contextual-fundamentals-tool.js');
        console.log('✅ Tool imports successful');
    } catch (e) {
        console.error('❌ Tool import failed:', e);
    }
}

async function main() {
    await testMutex();
    await testImports();
    console.log('Verification complete.');
}

main().catch(console.error);
