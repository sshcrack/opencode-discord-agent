#!/bin/bash
# Usage: ./run-worker.sh [--daemon|stop]
#   --daemon  Run worker in background with nohup (restarts on crash)
#   stop      Stop a daemonized worker
#   (no args) Run worker in foreground

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="/tmp/opencode-worker.pid"
LOG_FILE="/tmp/opencode-worker.log"

start_daemon() {
  cd "$ROOT"

  # Source .env if it exists
  if [ -f .env ]; then
    set -a
    source .env
    set +a
  fi

  echo "Starting worker daemon from $ROOT..."
  echo "Log: $LOG_FILE"
  echo "PID: $$" > "$PID_FILE"

  # Restart loop — keep worker alive if it crashes
  while true; do
    bun run --cwd packages/worker dev >> "$LOG_FILE" 2>&1
    echo "[daemon] Worker exited at $(date), restarting in 3s..." >> "$LOG_FILE"
    sleep 3
  done
}

stop_daemon() {
  if [ ! -f "$PID_FILE" ]; then
    echo "No PID file found at $PID_FILE — worker may not be running."
    exit 1
  fi

  PID=$(cat "$PID_FILE")
  echo "Stopping worker (PID: $PID)..."
  kill "$PID" 2>/dev/null || echo "Process $PID not found."

  # Kill child bun processes too
  pkill -f "bun.*packages/worker" 2>/dev/null || true

  rm -f "$PID_FILE"
  echo "Worker stopped."
}

case "${1:-}" in
  --daemon)
    # Fork into background
    nohup "$0" _daemon_inner > /dev/null 2>&1 &
    echo "Worker started in background (PID: $!)"
    echo "Monitor with: tail -f $LOG_FILE"
    ;;
  _daemon_inner)
    start_daemon
    ;;
  stop)
    stop_daemon
    ;;
  *)
    # Foreground — source .env and run directly
    cd "$ROOT"
    if [ -f .env ]; then
      set -a
      source .env
      set +a
    fi
    exec bun run --cwd packages/worker dev
    ;;
esac
