#!/bin/bash
# Launch Kata Agents demo with completely isolated configuration
# This uses KATA_CONFIG_DIR to point to a separate demo directory
# Your normal ~/.kata-agents/ is completely untouched!

DEMO_CONFIG_DIR="$HOME/.kata-agents-demo"
DEMO_APP_PATH="/Users/gannonhall/dev/kata/kata-agents/apps/electron/release/extracted-demo/Kata Agents.app"

echo "🎬 Launching Kata Agents Demo"
echo "   Demo config: $DEMO_CONFIG_DIR"
echo "   Your config: ~/.kata-agents (untouched)"
echo ""

# Create demo config directory if it doesn't exist
if [ ! -d "$DEMO_CONFIG_DIR" ]; then
  echo "📁 Creating demo configuration directory..."
  mkdir -p "$DEMO_CONFIG_DIR"
  echo "✓ Demo directory created"
fi

# Launch with KATA_CONFIG_DIR pointing to demo folder
# Note: Use the binary directly so environment variables propagate
KATA_CONFIG_DIR="$DEMO_CONFIG_DIR" \
  "$DEMO_APP_PATH/Contents/MacOS/Kata Agents" &

echo ""
echo "✓ Demo launched!"
echo "   All demo data goes to: $DEMO_CONFIG_DIR"
echo "   Your data remains in: ~/.kata-agents"
