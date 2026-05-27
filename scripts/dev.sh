#!/bin/bash
# ── ModuleWarden Development Helper ──────────────────────────
# Usage: ./scripts/dev.sh [command]
#
# Commands:
#   setup    - Install dependencies and generate Prisma client
#   dev      - Start Docker Compose stack
#   stop     - Stop Docker Compose stack
#   lint     - Run lint across all packages
#   test     - Run tests across all packages
#   typecheck - Typecheck all packages
#   clean    - Clean build artifacts

set -e

case "${1:-dev}" in
  setup)
    echo "📦 Installing dependencies..."
    pnpm install
    echo "🔧 Generating Prisma client..."
    pnpm generate
    echo "✅ Setup complete"
    ;;
  dev)
    echo "🚀 Starting ModuleWarden stack..."
    docker compose up -d
    echo "✅ Stack started"
    ;;
  stop)
    echo "🛑 Stopping ModuleWarden stack..."
    docker compose down
    echo "✅ Stack stopped"
    ;;
  lint)
    echo "🔍 Running lint..."
    pnpm lint
    ;;
  test)
    echo "🧪 Running tests..."
    pnpm test
    ;;
  typecheck)
    echo "🔎 Running typecheck..."
    pnpm typecheck
    ;;
  clean)
    echo "🧹 Cleaning build artifacts..."
    pnpm clean
    echo "✅ Clean complete"
    ;;
  *)
    echo "Unknown command: $1"
    echo "Usage: ./scripts/dev.sh [setup|dev|stop|lint|test|typecheck|clean]"
    exit 1
    ;;
esac
