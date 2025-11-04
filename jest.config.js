module.exports = {
    testEnvironment: 'node',
    collectCoverageFrom: [
        'helper/**/*.js',
        'services/**/*.js',
        'routes/**/*.js',
        '!routes/**/*.test.js',
        '!**/node_modules/**'
    ],
    coverageDirectory: 'coverage',
    coverageThreshold: {
        global: {
            branches: 50,
            functions: 50,
            lines: 50,
            statements: 50
        }
    },
    testMatch: [
        '**/tests/**/*.test.js'
    ],
    verbose: true,
    testTimeout: 10000,
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/$1'
    }
};
