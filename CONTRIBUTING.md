# Contributing to COC (ChainOfClaw)

Thank you for your interest in contributing to COC! We welcome developers, writers, security researchers, and node operators.

## Bounty Program

All merged contributions are eligible for bounties:

| Label | Bounty | Examples |
|-------|--------|---------|
| `priority:critical` | $500-$5,000 | Core consensus, security fixes |
| `priority:high` | $200-$2,000 | Key features, integrations |
| `priority:medium` | $100-$500 | Improvements, optimizations |
| `good first issue` | $50-$200 | Docs, translations, simple fixes |

## Getting Started

1. **Find an issue**: Browse [open issues](https://github.com/chainofclaw/COC/issues) or the [Project Board](https://github.com/users/chainofclaw/projects/1)
2. **Claim it**: Comment "I'd like to work on this" on the issue
3. **Fork & branch**: `git checkout -b feature/your-feature`
4. **Code & test**: Follow the guidelines below
5. **Submit PR**: Reference the issue number

## Development Setup

```bash
# Prerequisites: Node.js 22+
git clone https://github.com/chainofclaw/COC.git
cd COC
npm install

# Run node
cd node && npm start

# Run tests (846+ tests)
cd node && node --experimental-strip-types --test --test-force-exit src/*.test.ts src/**/*.test.ts

# Run contract tests
cd contracts && npm test

# Run explorer
cd explorer && npm run dev

# Run website
cd website && npm run dev
```

## Code Guidelines

- **Language**: TypeScript (strict mode, no `any`)
- **Tests**: Required for all new features (node:test framework)
- **Style**: Comments in English, keep files under 500 LOC
- **Immutability**: Create new objects, never mutate
- **Error handling**: Always handle errors with meaningful messages

## Pull Request Process

1. Ensure all tests pass
2. Update relevant documentation
3. Write a clear PR description referencing the issue
4. Wait for review (usually within 48 hours)
5. Address feedback and get approval
6. Bounty paid after merge

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `node/` | Blockchain core (consensus, EVM, P2P, RPC) |
| `contracts/` | Solidity smart contracts |
| `services/` | PoSe off-chain services |
| `explorer/` | Block explorer (Next.js) |
| `website/` | Project website (Next.js + i18n) |
| `scripts/` | DevOps and deployment scripts |

## Testnet Milestones

See [Milestones](https://github.com/chainofclaw/COC/milestones) for the Prowl testnet launch timeline.

## Community

- [GitHub Discussions](https://github.com/chainofclaw/COC/discussions)
- Discord (coming soon)

## Security

For security vulnerabilities, please use the [Security Report template](https://github.com/chainofclaw/COC/issues/new?template=security_report.yml) or email security@chainofclaw.io for critical issues.
