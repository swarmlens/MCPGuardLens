<!--
  MCPGuard — Production Deployment Guide
  © 2026 SwarmLens.com — Apache 2.0 License
-->

# MCPGuard — Production Deployment

> **Developed by [SwarmLens.com](https://swarmlens.com)**  
> Apache 2.0 — free to use and modify with attribution.

Deploy MCPGuard in front of your production MCP server with TLS,
API key auth, and persistent monitoring.

---

## Architecture

```
AI agents / Claude Desktop
       │  HTTPS
       ▼
  nginx (your existing SSL)
       │  http://127.0.0.1:8080
       ▼
MCPGuard Gateway  ──logs──▶  ClickHouse (internal only)
       │                           │
       │ JSON-RPC            Grafana :3001
       ▼                    (via nginx SSL)
Your MCP server (mcp.yourdomain.com)
```

All containers bind to `127.0.0.1` only. nginx handles SSL termination.
ClickHouse has no public port.

---

## Prerequisites

- Server with Docker 24+ and Docker Compose 2.20+
- nginx with existing SSL certificates (Let's Encrypt or your own)
- Two (sub)domains pointing to your server:
  - `mcpguard.yourdomain.com` — gateway (agents connect here)
  - `grafana.yourdomain.com` — dashboard (admin access)
- Your MCP server running and reachable (can be on same server or remote)

---

## Step 1 — Clone and configure

```bash
git clone https://github.com/swarmlens/mcpguard.git
cd mcpguard

cp .env.example .env
nano .env
```

Fill in `.env`:

```env
# Your real MCP server URL
UPSTREAM_MCP=https://mcp.yourdomain.com

# Generate secrets
# openssl rand -hex 32
GATEWAY_API_KEY=your-generated-key

# openssl rand -hex 24
CLICKHOUSE_PASSWORD=your-strong-password

# openssl rand -hex 16
GRAFANA_ADMIN_PASSWORD=your-strong-password

GRAFANA_DOMAIN=grafana.yourdomain.com
CLICKHOUSE_USER=mcpguard
CLICKHOUSE_DB=mcpguard
GRAFANA_ADMIN_USER=admin
RATE_LIMIT_MAX=30
RATE_LIMIT_WINDOW=30
BLOCK_PATTERNS=rm -rf,DROP TABLE,/etc/passwd,/etc/shadow,../
LOG_LEVEL=info
```

---

## Step 2 — nginx config

Add to your nginx sites:

```bash
sudo nano /etc/nginx/sites-available/mcpguard
```

```nginx
# Gateway — agents connect here over HTTPS
server {
    listen 443 ssl;
    server_name mcpguard.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Connection        '';
        proxy_buffering    off;
        proxy_read_timeout 3600s;
    }
}

# Grafana dashboard
server {
    listen 443 ssl;
    server_name grafana.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass       http://127.0.0.1:3001;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
    }
}

# HTTP → HTTPS redirect
server {
    listen 80;
    server_name mcpguard.yourdomain.com grafana.yourdomain.com;
    return 301 https://$host$request_uri;
}
```

```bash
sudo ln -s /etc/nginx/sites-available/mcpguard /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## Step 3 — Start the stack

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Watch services come up:
```bash
docker compose -f docker-compose.prod.yml ps
# All should show: healthy or running
```

---

## Step 4 — Force ClickHouse schema

If this is a fresh deployment or schema is missing:

```bash
docker exec mcpguard-clickhouse clickhouse-client \
  --user mcpguard \
  --password $(grep CLICKHOUSE_PASSWORD .env | cut -d= -f2) \
  --query "CREATE DATABASE IF NOT EXISTS mcpguard"

docker exec mcpguard-clickhouse clickhouse-client \
  --user mcpguard \
  --password $(grep CLICKHOUSE_PASSWORD .env | cut -d= -f2) \
  --query "CREATE TABLE IF NOT EXISTS mcpguard.tool_calls
  (ts DateTime DEFAULT now(), agent_id String, tool String,
   verdict String, latency_ms UInt32, inject_score Float32,
   block_reason String, params_hash String)
  ENGINE=MergeTree() ORDER BY (ts,agent_id)
  TTL ts + INTERVAL 30 DAY"
```

---

## Step 5 — Verify

```bash
# Gateway health
curl https://mcpguard.yourdomain.com/health \
  -H "X-MCPGuard-Key: $(grep GATEWAY_API_KEY .env | cut -d= -f2)"

# Tools list from your real MCP server through the gateway
curl https://mcpguard.yourdomain.com/tools/list \
  -H "X-MCPGuard-Key: $(grep GATEWAY_API_KEY .env | cut -d= -f2)" \
  | python3 -m json.tool

# Real tool call
curl -X POST https://mcpguard.yourdomain.com/tools/call \
  -H "Content-Type: application/json" \
  -H "X-MCPGuard-Key: $(grep GATEWAY_API_KEY .env | cut -d= -f2)" \
  -d '{"tool":"your_tool_name","parameters":{},"agent_id":"smoke-test"}'
```

Open Grafana: `https://grafana.yourdomain.com`

---

## Step 6 — Point your agents at the gateway

Anywhere your agent currently calls your MCP server directly:

```python
# Before
MCP_URL = "https://mcp.yourdomain.com"

# After
MCP_URL = "https://mcpguard.yourdomain.com"
HEADERS = {"X-MCPGuard-Key": "your-gateway-api-key"}
```

For Claude Desktop (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "your-server": {
      "url": "https://mcpguard.yourdomain.com"
    }
  }
}
```

---

## Optional: Add test MCP server (mcp-everything)

If you don't have a real MCP server yet and want to test:

```yaml
# Add to docker-compose.prod.yml
mcp-everything:
  image: node:20-alpine
  container_name: mcpguard-mcp-everything
  restart: always
  ports:
    - "127.0.0.1:3100:3000"
  command: sh -c "npx -y @modelcontextprotocol/server-everything streamableHttp"
  environment:
    - PORT=3000
  networks:
    - mcpguard
```

Set `UPSTREAM_MCP=http://mcp-everything:3000` in `.env` and restart gateway.

---

## Run attack simulator against production

```bash
docker compose -f docker-compose.prod.yml --profile test run --rm attack-sim \
  python sim.py --attack all \
  --gateway http://gateway:8080 \
  --api-key $(grep GATEWAY_API_KEY .env | cut -d= -f2)
```

---

## Maintenance

### View logs
```bash
docker compose -f docker-compose.prod.yml logs -f gateway
docker compose -f docker-compose.prod.yml logs -f clickhouse
```

### Update
```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

### Backup ClickHouse data
```bash
docker exec mcpguard-clickhouse clickhouse-client \
  --user mcpguard \
  --password $(grep CLICKHOUSE_PASSWORD .env | cut -d= -f2) \
  --query "SELECT * FROM mcpguard.tool_calls FORMAT CSV" \
  > backup-$(date +%Y%m%d).csv
```

### Rotate gateway API key
```bash
# Generate new key
NEW_KEY=$(openssl rand -hex 32)
sed -i "s/GATEWAY_API_KEY=.*/GATEWAY_API_KEY=$NEW_KEY/" .env
docker compose -f docker-compose.prod.yml restart gateway
echo "New key: $NEW_KEY"
# Update all agents to use new key
```

---

## Security checklist

- [ ] `.env` is in `.gitignore` and never committed
- [ ] `CLICKHOUSE_PASSWORD` is a strong random string
- [ ] `GATEWAY_API_KEY` is a strong random string  
- [ ] ClickHouse has no public port (only `expose:`, not `ports:`)
- [ ] Grafana `GF_USERS_ALLOW_SIGN_UP=false`
- [ ] nginx has HTTPS-only (HTTP redirects to HTTPS)
- [ ] Firewall blocks direct access to ports 8080, 3001, 8123, 9000

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `pull access denied for mcpguard-gateway` | Run `docker compose -f docker-compose.prod.yml up -d --build` |
| `upstream parse error` | Gateway and MCP server transport mismatch — check `docker logs mcpguard-gateway` |
| Grafana shows no data | Verify ClickHouse password in Grafana datasource settings matches `.env` |
| 401 on all gateway requests | Check `X-MCPGuard-Key` header matches `GATEWAY_API_KEY` in `.env` |
| Containers on wrong network | `docker compose -f docker-compose.prod.yml down && up -d` |

---

## Credits

Built by **[SwarmLens.com](https://swarmlens.com)**  
Apache 2.0 — retain attribution to SwarmLens.com in any derivative works.
