#!/bin/bash

# CV Agent Stop Script
# Cleanly stops all CV agents

echo "🛑 Stopping CV Agent System"
echo "=========================="

# Stop agents using saved PIDs if available
if [ -f .agent_pids ]; then
    echo "📋 Stopping agents using saved PIDs..."
    read VOICE_PID VISION_PID BROWSER_PID ORCHESTRATOR_PID < .agent_pids
    
    for pid in $VOICE_PID $VISION_PID $BROWSER_PID $ORCHESTRATOR_PID; do
        if [ ! -z "$pid" ] && kill -0 $pid 2>/dev/null; then
            echo "  Stopping process $pid..."
            kill $pid
        fi
    done
    
    # Wait for graceful shutdown
    sleep 3
    
    # Force kill if still running
    for pid in $VOICE_PID $VISION_PID $BROWSER_PID $ORCHESTRATOR_PID; do
        if [ ! -z "$pid" ] && kill -0 $pid 2>/dev/null; then
            echo "  Force stopping process $pid..."
            kill -9 $pid
        fi
    done
    
    rm -f .agent_pids
else
    echo "📋 No saved PIDs found, using process names..."
fi

# Fallback: kill by process name
echo "🔍 Killing any remaining agent processes..."
pkill -f "python.*agents" 2>/dev/null || echo "No agent processes found"

# Wait a moment
sleep 2

# Check if any are still running
echo "🔍 Checking for remaining processes..."
remaining=$(pgrep -f "python.*agents" | wc -l)

if [ $remaining -eq 0 ]; then
    echo "✅ All agents stopped successfully"
else
    echo "⚠️ $remaining agent processes still running"
    echo "You may need to manually stop them:"
    pgrep -f "python.*agents" | while read pid; do
        echo "  kill -9 $pid"
    done
fi

echo ""
echo "🧹 CV Agent System stopped"