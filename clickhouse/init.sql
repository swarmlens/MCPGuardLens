-- MCPGuard ClickHouse schema

CREATE DATABASE IF NOT EXISTS mcpguard;

CREATE TABLE IF NOT EXISTS mcpguard.tool_calls
(
    ts           DateTime DEFAULT now(),
    agent_id     String,
    tool         String,
    verdict      Enum8('allow'=1, 'block'=2, 'review'=3, 'error'=4),
    latency_ms   UInt32,
    inject_score Float32,
    block_reason String,
    params_hash  String
)
ENGINE = MergeTree()
ORDER BY (ts, agent_id)
TTL ts + INTERVAL 30 DAY;
