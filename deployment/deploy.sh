#!/bin/bash
# Trading Intelligence MCP - Production Deployment Script
# Run this script to deploy v0.1 to production

set -e  # Exit on error

echo "🚀 Trading Intelligence MCP - Production Deployment"
echo "=================================================="
echo ""

# Color codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Step 1: Pre-flight checks
echo "${YELLOW}Step 1: Pre-flight Checks${NC}"
echo "----------------------------"

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "${RED}Error: package.json not found. Are you in the project root?${NC}"
    exit 1
fi

echo "${GREEN}✓${NC} In correct directory"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "${YELLOW}Installing dependencies...${NC}"
    npm install
fi

echo "${GREEN}✓${NC} Dependencies installed"

# Step 2: Run tests
echo ""
echo "${YELLOW}Step 2: Running Tests${NC}"
echo "----------------------------"

npm test
TEST_RESULT=$?

if [ $TEST_RESULT -ne 0 ]; then
    echo "${RED}Tests failed! Fix issues before deploying.${NC}"
    exit 1
fi

echo "${GREEN}✓${NC} All tests passed"

# Step 3: Build
echo ""
echo "${YELLOW}Step 3: Building Project${NC}"
echo "----------------------------"

npm run build
BUILD_RESULT=$?

if [ $BUILD_RESULT -ne 0 ]; then
    echo "${RED}Build failed! Check TypeScript errors.${NC}"
    exit 1
fi

echo "${GREEN}✓${NC} Build successful"

# Step 4: Verify dist folder
if [ ! -d "dist" ]; then
    echo "${RED}Error: dist folder not created${NC}"
    exit 1
fi

echo "${GREEN}✓${NC} Dist folder verified"

# Step 5: Environment check
echo ""
echo "${YELLOW}Step 4: Environment Check${NC}"
echo "----------------------------"

if [ ! -f ".env" ]; then
    echo "${YELLOW}⚠ No .env file found. Using environment variables.${NC}"
else
    echo "${GREEN}✓${NC} .env file present"
fi

# Check critical environment variables
REQUIRED_VARS=("REDIS_URL" "ALPHA_VANTAGE_API_KEY")
MISSING_VARS=()

for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        MISSING_VARS+=("$var")
    fi
done

if [ ${#MISSING_VARS[@]} -ne 0 ]; then
    echo "${RED}Error: Missing required environment variables:${NC}"
    for var in "${MISSING_VARS[@]}"; do
        echo "  - $var"
    done
    echo ""
    echo "Set these in Railway dashboard or .env file"
    exit 1
fi

echo "${GREEN}✓${NC} All required environment variables present"

# Step 6: Git status
echo ""
echo "${YELLOW}Step 5: Git Status${NC}"
echo "----------------------------"

if [ -d ".git" ]; then
    # Check for uncommitted changes
    if [ -n "$(git status --porcelain)" ]; then
        echo "${YELLOW}⚠ Uncommitted changes detected${NC}"
        echo ""
        git status --short
        echo ""
        read -p "Commit changes before deploying? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            git add .
            read -p "Enter commit message: " COMMIT_MSG
            git commit -m "$COMMIT_MSG"
            echo "${GREEN}✓${NC} Changes committed"
        fi
    else
        echo "${GREEN}✓${NC} No uncommitted changes"
    fi
    
    # Check if remote exists
    if git remote get-url origin > /dev/null 2>&1; then
        echo "${GREEN}✓${NC} Git remote configured"
        
        read -p "Push to GitHub? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            git push origin main
            echo "${GREEN}✓${NC} Pushed to GitHub"
        fi
    else
        echo "${YELLOW}⚠ No git remote configured${NC}"
    fi
else
    echo "${YELLOW}⚠ Not a git repository${NC}"
fi

# Step 7: Deployment summary
echo ""
echo "${GREEN}================================================${NC}"
echo "${GREEN}✓ Pre-Deployment Checks Complete!${NC}"
echo "${GREEN}================================================${NC}"
echo ""
echo "Next Steps:"
echo "1. Deploy to Railway:"
echo "   - Go to https://railway.app"
echo "   - Create new project from GitHub"
echo "   - Select this repository"
echo "   - Add environment variables"
echo "   - Deploy!"
echo ""
echo "2. Verify deployment:"
echo "   - curl https://your-url.railway.app/health"
echo ""
echo "3. Run verification tests (see DEMO_PACKAGE_FOR_ALEX.md)"
echo ""
echo "${GREEN}Ready for production! 🚀${NC}"
