# Phase Q.1 — Reed-Solomon library benchmark

Self-contained benchmark for `@ronomon/reed-solomon` covering RS(4+2), RS(6+3),
RS(8+4), RS(10+4) at 1 / 10 / 100 MB.

Verifies byte-identical decode after corrupting M data shards. Reports median
encode + decode latency across 3 runs and throughput in MB/s.

## Run locally (single-host)

```bash
cd scripts/phase-q-benchmark
npm install @ronomon/reed-solomon  # native binding — needs gcc + node-gyp + python3
node benchmark.mjs
```

## Run on a 4-core validator (Q.7)

The library is a native addon and needs `build-essential` to compile. Either:

1. Install build tools on the validator (one-time cost):
   ```bash
   ssh root@<validator> 'apt-get install -y build-essential python3'
   ```
2. Or run the benchmark on a representative VM (4-core x86_64) without touching
   the live validator.

Then:

```bash
scp benchmark.mjs root@<validator>:/tmp/
ssh root@<validator> '
  mkdir -p /tmp/rs-bench && cd /tmp/rs-bench
  npm init -y >/dev/null
  npm install @ronomon/reed-solomon
  cp /tmp/benchmark.mjs .
  node benchmark.mjs
'
```

## Simulating 4 cores locally

```bash
taskset -c 0,1,2,3 node benchmark.mjs
```

## Acceptance bar (Q.1)

Encode RS(4+2) on a 10 MB file: **< 300 ms** (per design doc §6 / §11).

Local 4-core proxy run achieved **3.2 ms**, ~94× under target.
