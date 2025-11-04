/**
 * Jest Setup File
 * Runs before all tests
 */

// Increase timeout for database operations
jest.setTimeout(10000);

// Mock console methods to reduce noise during tests
const originalLog = console.log;
const originalWarn = console.warn;

// Optional: Uncomment to suppress logs during tests
// console.log = jest.fn();
// console.warn = jest.fn();

// Restore after tests if needed
afterAll(() => {
    console.log = originalLog;
    console.warn = originalWarn;
});
