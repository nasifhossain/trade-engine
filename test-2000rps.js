#!/usr/bin/env node

/**
 * Quick Test Script for 2000 RPS Load Testing
 * 
 * This is a convenience wrapper around the precise 2000 RPS test
 * 
 * Usage:
 *   node test-2000rps.js [duration_in_seconds]
 * 
 * Examples:
 *   node test-2000rps.js        # Run for 60 seconds (default)
 *   node test-2000rps.js 30     # Run for 30 seconds
 *   node test-2000rps.js 120    # Run for 2 minutes
 */

const { runPrecise2000RpsLoadTest } = require('./test-matching-engine');

async function main() {
    const args = process.argv.slice(2);
    const duration = parseInt(args[0]) || 60;
    
    console.log(`\n🚀 Starting Precise 2000 RPS Load Test for ${duration} seconds...\n`);
    
    try {
        const result = await runPrecise2000RpsLoadTest(duration);
        
        if (result.passed) {
            console.log('\n✅ Test completed successfully!\n');
            process.exit(0);
        } else {
            console.log('\n⚠️  Test completed with some targets not met\n');
            console.log('💡 Tip: Check the metrics above to identify bottlenecks\n');
            process.exit(1);
        }
    } catch (error) {
        console.error(`\n❌ Test failed with error: ${error.message}\n`);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

main();
