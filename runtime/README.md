# COC Runtime (Node / Agent / Relayer)

## Start (via OpenClaw)

```bash
openclaw coc config:init
openclaw coc start
openclaw coc status
```

## Logs

```bash
openclaw coc logs node
openclaw coc logs agent
openclaw coc logs relayer
```

## Direct run (debug)

```bash
node --experimental-strip-types COC/runtime/coc-node.ts
node --experimental-strip-types COC/runtime/coc-agent.ts
node --experimental-strip-types COC/runtime/coc-relayer.ts
```

## Config

`~/.clawdbot/coc/config.json` or `COC/config.example.json`

Agent 抽样与批次参数:
- `agentBatchSize` / `COC_AGENT_BATCH_SIZE`
- `agentSampleSize` / `COC_AGENT_SAMPLE_SIZE`
