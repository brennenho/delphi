#!/bin/bash

# CV Agent Startup Script
# Starts all agents for the Computer Vision system

set -e

echo "🚀 Starting CV Agent System"
echo "================================"

# Check if .env file exists
if [ ! -f .env ]; then
    echo "⚠️ Warning: .env file not found"
    echo "📝 Please create .env file with your API keys:"
    echo "   GEMINI_API_KEY=your_key_here"
    echo "   OPENAI_API_KEY=your_key_here"
    echo ""
    read -p "Continue anyway? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Create logs directory
mkdir -p logs

# Kill any existing agent processes
echo "🛑 Stopping any existing agents..."
pkill -f "python.*agents" 2>/dev/null || echo "No existing agents found"
sleep 2

# Start agents in background
echo "🎭 Starting agents..."

echo "  🔊 Starting Voice Agent (Hermes) on port 8000..."
cd backend && python agents/voice.py > ../logs/voice.log 2>&1 &
VOICE_PID=$!
cd ..

sleep 3

echo "  👁️ Starting Vision Agent (Theia) on port 8003..."
cd backend && python agents/vision.py > ../logs/vision.log 2>&1 &
VISION_PID=$!
cd ..

sleep 2

echo "  🌐 Starting Browser Agent (Athena) on port 8001..."
cd backend && python agents/browser.py > ../logs/browser.log 2>&1 &
BROWSER_PID=$!
cd ..

sleep 2

echo "  🎯 Starting Orchestrator Agent (Zeus) on port 8002..."
cd backend && python agents/orchestrator.py > ../logs/orchestrator.log 2>&1 &
ORCHESTRATOR_PID=$!
cd ..

# Wait a bit for all agents to start
echo "⏳ Waiting for agents to initialize..."
sleep 5

# Check if agents are running
echo "🔍 Checking agent status..."

check_port() {
    local port=$1
    local name=$2
    if nc -z localhost $port 2>/dev/null; then
        echo "  ✅ $name is running on port $port"
        return 0
    else
        echo "  ❌ $name is not responding on port $port"
        return 1
    fi
}

success=0
check_port 8000 "Voice Agent (Hermes)" && ((success++))
check_port 8003 "Vision Agent (Theia)" && ((success++))
check_port 8001 "Browser Agent (Athena)" && ((success++))
check_port 8002 "Orchestrator (Zeus)" && ((success++))

echo ""
if [ $success -eq 4 ]; then
    echo "🎉 All agents started successfully!"
    echo ""
    echo "🎯 CV Agent System is ready!"
    echo "   • Browser actions will be automatically captured"
    echo "   • Vision analysis will describe what's happening"  
    echo "   • Voice narration will be played in real-time"
    echo ""
    echo "📊 Monitor logs:"
    echo "   tail -f logs/voice.log     # Voice agent"
    echo "   tail -f logs/vision.log    # Vision agent"
    echo "   tail -f logs/browser.log   # Browser agent"
    echo "   tail -f logs/orchestrator.log # Orchestrator"
    echo ""
    echo "🛑 To stop all agents:"
    echo "   ./stop_cv_agents.sh"
    echo "   or: pkill -f 'python.*agents'"
else
    echo "⚠️ Some agents failed to start. Check logs in logs/ directory"
    echo ""
    echo "🔧 Troubleshooting:"
    echo "   1. Check if ports are already in use: netstat -tulpn | grep ':800'"
    echo "   2. Verify API keys in .env file"
    echo "   3. Check individual log files in logs/ directory"
    echo "   4. Try running test_core_functionality.py first"
fi

# Save PIDs for stopping later
echo "$VOICE_PID $VISION_PID $BROWSER_PID $ORCHESTRATOR_PID" > .agent_pids

echo ""
echo "Process IDs saved to .agent_pids"
echo "Agents running in background. Use 'jobs' to see them."