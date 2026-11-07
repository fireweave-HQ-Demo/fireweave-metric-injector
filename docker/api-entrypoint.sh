#!/bin/sh
set -eu
cd /app
pnpm --filter @fireweave/db migrate:deploy
exec pnpm --filter @fireweave/api start
