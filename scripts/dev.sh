#!/usr/bin/env bash
# Starts Postgres, Redis, and the API, worker, and UI with file watching.
# Stop is the inverse: it ends those processes and stops the containers.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
run="$root/.run"
cd "$root"

port_busy() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

reserved=""

CLAIMED=""

claim_port() {
  local port=$1
  while port_busy "$port" || [[ " $reserved " == *" $port "* ]]; do
    port=$((port + 1))
  done
  reserved="$reserved $port"
  CLAIMED=$port
}

stop_group() {
  local pgid=$1
  if [[ -z "$pgid" || "$pgid" == "0" || "$pgid" == "1" ]]; then
    return
  fi
  kill -TERM -"$pgid" 2>/dev/null || true
}

in_repo() {
  local pid=$1
  local cwd
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/ { print substr($0, 2); exit }')
  [[ "$cwd" == "$root" || "$cwd" == "$root"/* ]]
}

stop_matching() {
  local pattern=$1
  local pid pgid
  while read -r pid; do
    [[ -z "$pid" ]] && continue
    in_repo "$pid" || continue
    pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)
    stop_group "$pgid"
  done < <(pgrep -f "$pattern" || true)
}

stop_app() {
  mkdir -p "$run"
  local file pgid
  shopt -s nullglob
  for file in "$run"/*.pgid; do
    pgid=$(tr -d '[:space:]' < "$file")
    stop_group "$pgid"
    rm -f "$file" "${file%.pgid}.pid"
  done
  shopt -u nullglob
  stop_matching "$root/node_modules/.pnpm/tsx.*src/index.ts"
  stop_matching "$root/node_modules/.pnpm/tsx.*src/main.ts"
  stop_matching "next dev --port"
  stop_matching "next-server"
  sleep 0.4
}

stop_all() {
  stop_app
  docker compose stop >/dev/null || true
  rm -f "$run"/ports
  echo "Stopped."
}

group_is_listening() {
  local port=$1
  local pgid=$2
  local pid owner
  while read -r pid; do
    [[ -z "$pid" ]] && continue
    owner=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)
    if [[ "$owner" == "$pgid" ]]; then
      return 0
    fi
  done < <(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  return 1
}

wait_until_listening() {
  local name=$1
  local port=$2
  local i pid pgid
  pid=$(cat "$run/$name.pid")
  pgid=$(cat "$run/$name.pgid")
  for i in $(seq 1 90); do
    if group_is_listening "$port" "$pgid"; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$name exited before it was ready." >&2
      tail -n 40 "$run/$name.log" >&2
      exit 1
    fi
    sleep 0.5
  done
  echo "$name did not open port $port." >&2
  tail -n 40 "$run/$name.log" >&2
  exit 1
}

launch() {
  local name=$1
  shift
  "$@" >"$run/$name.log" 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" >"$run/$name.pid"
  ps -o pgid= -p "$pid" | tr -d '[:space:]' >"$run/$name.pgid"
}

start_all() {
  if [[ ! -f "$root/.env" ]]; then
    echo "Copy .env.example to .env and fill in the secrets first." >&2
    exit 1
  fi
  mkdir -p "$run"
  stop_app

  docker compose up -d --wait postgres redis
  set -a
  # shellcheck disable=SC1091
  source "$root/.env"
  set +a
  pnpm db:migrate

  set -m
  local api worker web
  claim_port 3002
  web=$CLAIMED
  claim_port 3000
  api=$CLAIMED
  claim_port 3001
  worker=$CLAIMED

  launch api env PORT="$api" pnpm --filter @fireweave/api dev
  launch worker env WORKER_METRICS_PORT="$worker" pnpm --filter @fireweave/worker dev
  launch web env API_URL="http://127.0.0.1:$api" WEB_PORT="$web" pnpm --filter @fireweave/web dev
  printf 'api=%s\nworker=%s\nweb=%s\n' "$api" "$worker" "$web" >"$run/ports"
  wait_until_listening web "$web"
  wait_until_listening api "$api"
  wait_until_listening worker "$worker"

  echo "UI   http://127.0.0.1:$web"
  echo "API  http://127.0.0.1:$api"
  echo "Code changes reload the API, the worker, and the UI."
  echo "pnpm stop shuts this down."
}

case "${1:-}" in
  start) start_all ;;
  stop) stop_all ;;
  *)
    echo "Usage: pnpm start | pnpm stop" >&2
    exit 1
    ;;
esac
