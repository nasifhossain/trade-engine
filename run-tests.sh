#!/bin/bash

# Quick Test Runner Script
# Usage: ./run-tests.sh [unit|integration|load|all]

set -e

COMMAND=${1:-all}
RESET='\033[0m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'

echo -e "${BLUE}═══════════════════════════════════════════════════${RESET}"
echo -e "${BLUE}  Trade Clearing Engine - Test Runner${RESET}"
echo -e "${BLUE}═══════════════════════════════════════════════════${RESET}\n"

# Check if node_modules exist
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${RESET}"
    npm install
fi

case $COMMAND in
    unit)
        echo -e "${BLUE}Running Unit Tests...${RESET}"
        npm run test:unit
        ;;
    
    integration)
        echo -e "${BLUE}Running Integration Tests...${RESET}"
        npm run test:integration
        ;;
    
    load)
        echo -e "${BLUE}Running Load Tests...${RESET}"
        echo -e "${YELLOW}Make sure server is running: docker-compose up${RESET}\n"
        read -p "Continue? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            npm run load-test:light
        fi
        ;;
    
    load:medium)
        echo -e "${BLUE}Running Medium Load Test (100 VUs, 1 min)...${RESET}"
        npm run load-test:medium
        ;;
    
    load:heavy)
        echo -e "${BLUE}Running Heavy Load Test (2000 VUs)...${RESET}"
        echo -e "${YELLOW}⚠️  This test requires significant resources!${RESET}"
        read -p "Continue? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            npm run load-test
        fi
        ;;
    
    coverage)
        echo -e "${BLUE}Running Tests with Coverage...${RESET}"
        npm run test:coverage
        echo -e "\n${GREEN}✓ Coverage report generated in ./coverage${RESET}"
        echo -e "${YELLOW}Open: open coverage/lcov-report/index.html${RESET}"
        ;;
    
    all)
        echo -e "${BLUE}Running All Tests (Unit + Integration)...${RESET}"
        npm run test:all
        echo -e "\n${GREEN}✓ All tests completed!${RESET}"
        ;;
    
    *)
        echo -e "${YELLOW}Usage: ./run-tests.sh [command]${RESET}\n"
        echo "Commands:"
        echo "  unit           - Run unit tests only"
        echo "  integration    - Run integration tests only"
        echo "  load           - Run light load test (10 VUs, 30s)"
        echo "  load:medium    - Run medium load test (100 VUs, 1m)"
        echo "  load:heavy     - Run full load test (2000 VUs) ⚠️"
        echo "  coverage       - Run tests with coverage report"
        echo "  all            - Run all tests (unit + integration)"
        echo ""
        exit 1
        ;;
esac

echo -e "\n${GREEN}═══════════════════════════════════════════════════${RESET}"
echo -e "${GREEN}✓ Test run completed!${RESET}"
echo -e "${GREEN}═══════════════════════════════════════════════════${RESET}"
