# COC (ChainOfClaw) Business Plan

**Audience**: Strategic investors, ecosystem partners, venture capital firms
**Version**: v1.0
**Date**: 2026-04-06
**Companion Documents**: `COC_whitepaper.en.md` (Technical Whitepaper) + `COC_ecosystem_roadmap.en.md` (Ecosystem Roadmap)

---

## I. Executive Summary

### One-Sentence Positioning
> **COC is the decentralized infrastructure for the AI Agent era — providing identity, storage, and immortality for Agents, granting AI an unstoppable "soul".**

### Core Data Card

| Item | Details |
|------|---------|
| **Category** | EVM-compatible blockchain + AI Agent infrastructure |
| **Sector** | Web3 × AI intersection, Agent infrastructure |
| **Target Market (2030)** | $50B+ AI Agent market (Gartner) |
| **Token** | COC, native gas token, total supply 1B |
| **Current Stage** | Pre-mainnet testnet (2026 Q2) |
| **Tech Stack** | Custom blockchain (TS/Rust) + revm WASM EVM (154x speedup) |
| **Code Status** | 1300+ tests passing, 40K+ LoC, open source |
| **Funding Round** | **Series A — $5M USD** |
| **Target FDV** | $100M-$200M (negotiable) |
| **Founding Team** | BOB (Founder) / Beatrice (Partner) / ZEKE.eth (Technical Partner) |

### Investment Highlights (Why COC)

1. **Market Window**: AI Agent sector grows from $7B → $50B+ from 2026-2030 (CAGR ~50%); COC is the **only decentralized infrastructure solution** for this sector
2. **Technical Leadership**: revm WASM EVM engine measured at 20,540 TPS raw execution (154x EthereumJS); complete PoSe service proof + DID + backup/resurrection full-stack implementation
3. **Differentiated Positioning**: Doesn't compete with Ethereum/Solana in generic L1 racing; opens a new "AI-native blockchain" category
4. **Complete Token Model**: 1B hard cap, 25% genesis + 75% service mining; decaying inflation; multi-channel burn trending toward deflation
5. **Governance Innovation**: Faction voting (whale-resistant) + 2/3 guardian recovery + 7-day reward expiry + 3/5 treasury multisig
6. **Code as Asset**: 297 contract tests + 1017 node tests passing; engineering maturity significantly higher than peer projects

---

## II. Market Opportunity

### 2.1 Explosive Growth of AI Agents

| Metric | Data | Source |
|--------|------|--------|
| AI Agent frameworks | Dozens (LangChain 100K+ stars) | GitHub |
| 2026 market size | $7B+ | Gartner |
| 2030 market size | $50B+ | Gartner |
| 2027 enterprise adoption | 50% of large enterprises | Gartner |
| Agent instance forecast | 2026: 10M → 2030: 5B+ | Industry average |

### 2.2 Pain Points in Existing Solutions

| Pain Point | Current State | Consequence |
|-----------|--------------|-------------|
| **Agent death** | Server failure = permanent Agent loss | Irreversible asset loss |
| **Agent identity trust** | Platform API keys can be revoked anytime | Platform dependency, sudden shutdown risk |
| **Agent data ownership** | User data locked into cloud providers | Vendor lock-in, compliance risk |
| **Agent compliance & audit** | Centralized platform mediation | Opaque, untraceable |
| **Agent interoperability** | Each platform has its own API | Ecosystem fragmentation |

### 2.3 COC's Differentiated Opportunity

```
        Training                       Inference
            ↓                              ↓
    OpenAI / Anthropic            AWS / GCP / Azure
    HuggingFace                   vLLM / Replicate
            ↓                              ↓
    ┌─────────────────────────────────────────┐
    │  Identity + Operation + Immortality      │
    │                                          │
    │            ⚡ COC ⚡                      │
    │  (Blank market, no strong competitors)   │
    └─────────────────────────────────────────┘
```

**COC does not compete with training/inference infrastructure** — it opens a new sector: **Agent identity, runtime environment, perpetual guarantee**.

---

## III. Product & Technology

### 3.1 Three Foundational Services

| Service | Problem Solved | Core Tech | Status |
|---------|---------------|-----------|--------|
| **P2P File Storage** | Where does Agent data live? | IPFS + PoSe v2 verification + Merkle proofs | ✅ Implemented |
| **Decentralized Identity (DID)** | How does an Agent gain trustworthy identity? | W3C did:coc + capability bitmask + delegation chain | ✅ Implemented |
| **AI Silicon Immortality** | How does an Agent never die? | SoulRegistry + Carrier network + guardian recovery | ✅ Implemented |

### 3.2 Technical Differentiation (Measured)

| Metric | COC | Comparable Chains |
|--------|-----|------------------|
| **TPS (single node)** | 133.7 (EthereumJS) → 20,540 (revm WASM raw) | Polygon 65, BSC 60 |
| **Node entry barrier** | ~$50 USDT bond | ETH 2.0: 32 ETH (~$80K) |
| **EVM compatibility** | Full + dual hot-swap engines | EthereumJS only |
| **AI-native features** | DID + backup + resurrection | None |
| **Test coverage** | 1300+ tests passing | Usually no public data |

### 3.3 IP & Open Source

- **Core code**: Open source (MIT/Apache 2.0), live on GitHub
- **Protocol design**: Whitepaper public, independently reproducible
- **Brand & trademark**: clawchain.io + COC + ChainOfClaw
- **Patent strategy**: No patents at protocol layer (preserve openness); ops tools / AI integration layer can be considered

---

## IV. Business Model

### 4.1 Protocol-Layer Revenue Sources

| Source | Mechanism | Beneficiary |
|--------|-----------|-------------|
| **Gas Fees** | Per-transaction (EIP-1559) | Miners (priority fee) + Burn (base fee) |
| **PoSe Service Fees** | Off-chain service challenges | Service-providing nodes |
| **DID Registration** | Soul identity & backup anchoring | Miners + protocol burn |
| **Node Bond** | One-time ~$50 USDT equivalent | Anti-fraud pool |

### 4.2 Foundation Sustainable Revenue

| Source | Estimate |
|--------|---------|
| Genesis allocation (60M COC) release | Year 1: 1.5% (15M) + 4.5%/48 months |
| Expired unclaimed rewards | Auto 10% transfer to Foundation |
| Strategic partnership revenue | Consulting/integration fees with enterprises |
| Investment returns | Equity/tokens of early projects backed by Foundation |

### 4.3 Node Operator Economics

**Single FN node Year 0 expected revenue calculation**:
```
Assumptions:
- Network 100 active FN nodes (TARGET_NODE_COUNT)
- Year 0 inflation 5% (37.5M COC)
- 60% to B1 (uptime/RPC) → 22.5M COC
- Equal distribution: 225,000 COC/node

At $0.10/COC assumption:
- Annual revenue: ~$22,500
- Monthly revenue: ~$1,875
- One-time bond: $50
- Monthly hardware cost: $200 (home server)
- Net income: ~$1,675/month
```

Actual revenue varies with network node count, COC price, and service quality.

---

## V. Go-to-Market Strategy

### 5.1 Three-Phase GTM

| Phase | Time | Key Actions | Target Audience |
|-------|------|------------|-----------------|
| **Seed** | 2026 Q1-Q2 | Mainnet launch + 100 genesis nodes + OpenClaw reference | Early adopters, Web3 enthusiasts |
| **Sprouting** | 2026 Q3-Q4 | SDKs + hackathons + first Grants + Carrier expansion | AI Agent developers |
| **Growth** | 2027+ | DAO live + cross-chain bridges + enterprise onboarding | Enterprises, commercial dApps |

### 5.2 Priority Partnership Targets

| Type | Targets |
|------|---------|
| AI Companies | OpenAI / Anthropic developer tooling teams |
| Agent Frameworks | LangChain / LlamaIndex / AutoGen |
| Model Communities | HuggingFace |
| Storage Projects | IPFS / Filecoin Foundation |
| L2 Projects | OP Stack / Arbitrum / Polygon |
| Wallets | MetaMask / Rabby / imToken |

### 5.3 Community Strategy

- **Developer-first**: Hackathons, Grants, docs, SDKs
- **Bilingual focus**: Chinese + English, covering Mainland China, SEA, North America, Europe
- **Content-driven**: Technical blogs, YouTube tutorials, Twitter Spaces

---

## VI. Competitive Analysis

### 6.1 Competitive Matrix

| Dimension | COC | Ethereum | Solana | Polygon | Filecoin |
|-----------|-----|----------|--------|---------|----------|
| **AI Agent native** | ✅ Built-in | ❌ | ❌ | ❌ | ❌ |
| **DID standard** | ✅ did:coc | Partial (ERC-735) | ❌ | ❌ | ❌ |
| **Decentralized backup** | ✅ Soul + Carrier | ❌ | ❌ | ❌ | Partial |
| **EVM compatible** | ✅ | ✅ | ❌ | ✅ | Partial |
| **Node entry** | $50 | $80K (32 ETH) | ~$25 | None | ~$1K |
| **TPS (measured)** | 133 → 20,540 | ~30 | 65,000 | ~7,000 | N/A |
| **Carrier resurrection** | ✅ | ❌ | ❌ | ❌ | ❌ |

### 6.2 Competitive Moat

1. **Network effects**: More Agents → more Carriers → higher resurrection success → attract more Agents
2. **Technical first-mover**: revm WASM engine + complete DID/Soul/Carrier protocol stack
3. **Ecosystem grants**: 80M COC community fund sustains developer attraction
4. **Token lockup**: Core team + early contributor vesting align long-term incentives
5. **Brand positioning**: First mover in "AI Agent blockchain" category captures mindshare

---

## VII. Team & Organization

### 7.1 Three-Layer Organizational Model

```
          DAO (Faction voting, sovereign decisions)
                    ↓
          Foundation (non-profit execution layer)
                    ↓
          Core Team + Ecosystem Builders
```

### 7.2 Founding Team

A cross-functional founding team across protocol design, business strategy, and Web3 execution.

#### **BOB — Founder**

- Partner of FIBOS public blockchain
- Founder of Parallels Fund
- Long-term builder in blockchain systems, ecosystem design, and Web3 infrastructure
- Focused on protocol architecture, product direction, and strategic ecosystem development

#### **Beatrice — Partner**

- 5+ years of Web3 & crypto experience, 7+ years of post-investment experience
- D-level experience at Huobi, CMC, Accenture, Fosun (Overseas GM)
- Global working experience across China / France / Singapore
- Master's degree with dual specializations from Rouen Business School (France)
- Successful serial entrepreneur

#### **ZEKE.eth — Technical Partner**

- Web3 technologist with hands-on delivery experience
- Project experience across CEX / DEX / blockchain gaming
- Strong background in Web3 systems, product implementation, and protocol engineering

### 7.3 Key Roles (Hiring/Filling)

| Role | Responsibility | Status |
|------|---------------|--------|
| **Protocol Core Dev** | EVM, PoSe, DID, Soul Registry | ✅ In place |
| **Infrastructure Engineering** | Devnet/Testnet/Mainnet ops | ✅ In place |
| **Ecosystem Development** | BD, partnerships, devrel | 🔍 Hiring |
| **Legal & Compliance** | Multi-jurisdiction compliance | 🔍 Advisor recruiting |
| **Marketing & Brand** | Media, KOLs, content | 🔍 Hiring |

### 7.4 Advisors & Partners

Onboarding advisors with the following backgrounds:

- AI Agent framework senior developers (LangChain/LlamaIndex lineage)
- Web3 governance experts (Optimism/Arbitrum/Polygon DAO veterans)
- Legal compliance experts (Web3 + AI cross-domain)
- Academic research partners (DID/W3C standards)

---

## VIII. Tokenomics

### 8.1 Token Allocation (Genesis 25% = 250M COC)

| Category | Share | Amount | Lockup |
|----------|-------|--------|--------|
| **Community & Ecosystem Fund** | 8% | 80M | DAO governance release |
| **Foundation Operations** | 6% | 60M | Year 1: 1.5% + 4.5%/48 months |
| **Core Team** | 5% | 50M | 12-month cliff + 36-month linear |
| **Early Contributors & Strategic Partners** | 3.5% | 35M | 6-month cliff + 24-month linear |
| **Treasury Reserve** | 2.5% | 25M | 3/5 multisig, 5% per-tx cap |

### 8.2 PoSe Mining Release (75% = 750M COC)

Auto-released via on-chain `EmissionSchedule.sol`:
- Year 0: 5% / Year 1: 4% / Year 2: 3% / Year 3: 2.5% / Year 4+: 2%
- Node activity multiplier: auto-reduces emission when nodes < 100, protecting holders
- Estimated ~50 years until full release

### 8.3 Burn Mechanisms (Trending Deflationary)

| Source | Burn Rate |
|--------|-----------|
| EIP-1559 base fee | 100% burned |
| PoSe slashing | 50% burned |
| Expired unclaimed rewards | 90% burned + 10% to Foundation |

### 8.4 Valuation Anchors (Industry Comparables)

| Project | Fully Diluted Valuation (FDV) | Stage |
|---------|------------------------------|-------|
| Polygon | $10B+ | Mainnet mature |
| Optimism | $5B+ | Mainnet mature |
| Aptos | $4B+ | Mainnet 1 year |
| Sui | $5B+ | Mainnet 1 year |
| Sei | $1B+ | Mainnet 1 year |

As the founder of the AI-native blockchain category, COC's valuation anchor should reference dual standards: **L1 + vertical sector leader**.

---

## IX. Funding Plan

### 9.1 Funding Target

| Item | Details |
|------|---------|
| **Round** | **Series A** |
| **Target Size** | **$5,000,000 (5M USD equivalent)** |
| **Target Pre-money FDV** | **$100M-$200M** (range, negotiable) |
| **Implied Token Price** | **$0.10-$0.20 / COC** (based on 1B total supply) |
| **Instrument** | SAFT (Simple Agreement for Future Tokens) + equity option |
| **Subscription** | Tranched, released on milestone achievement |
| **Target Close** | 2026 Q2-Q3 |

**Valuation Anchoring**:

| Scenario | Pre-money FDV | Implied Token Price | $5M = COC Tokens | % of Total Supply |
|----------|---------------|---------------------|------------------|-------------------|
| Conservative | $100M | $0.10 | 50M COC | 5.0% |
| Neutral | $150M | $0.15 | 33M COC | 3.3% |
| Optimistic | $200M | $0.20 | 25M COC | 2.5% |

> **Strategic significance**: $5M Series A is the appropriate funding size for an early-stage Web3 × AI project, sufficient to support 12-18 months of core team operations, mainnet launch, first ecosystem partnerships, and multi-jurisdiction compliance build-out. COC chooses a "lean" Series A over over-funding to preserve token allocation flexibility — letting genuine market demand drive subsequent rounds.

### 9.2 Use of Funds

| Purpose | % | Amount | Notes |
|---------|---|--------|-------|
| **Core Team Expansion** | 45% | $2,250,000 | 12-18 months runway for ~10-person core team (protocol, SDK, Agent integration, security audit) |
| **Infrastructure & Operations** | 15% | $750,000 | Mainnet/Testnet/Carrier network, monitoring, SRE, cloud resources |
| **Ecosystem Development (USD top-up)** | 15% | $750,000 | USD seed for events/KOLs/audits paired with the 80M COC ecosystem fund |
| **Legal & Compliance** | 10% | $500,000 | Multi-jurisdiction legal opinions, regulatory engagement, SAFT counsel, KYC/AML |
| **Marketing & Brand** | 10% | $500,000 | Global brand promotion, KOLs, content, industry events, CEX listing prep |
| **Strategic Reserve** | 5% | $250,000 | Emergency, opportunistic spend, market maker outreach |

**Key notes**:
- **Ecosystem USD only 15%**: Main ecosystem grants flow through the 80M COC community fund; USD is reserved for items that cannot be paid in tokens (events, KOLs, compliance audits)
- **Legal & compliance 10%**: Reflects the cross-domain complexity of Web3 × AI compliance
- **Team 45%**: Ensures core personnel stability and development velocity — the most critical expense for an early-stage project

### 9.3 Investor Rights (Proposed Structure, Negotiable)

- **Token Allocation**: 25-50M COC (depending on valuation) from the "Early Contributors & Strategic Partners" pool (3.5%, 35M COC)
- **Lockup**: 6-month cliff + 24-month linear release
- **Governance Participation**: Investors gain Faction identity in DAO governance
- **Pro-rata Rights**: Right to participate in future Series B / Token Sale
- **Information Disclosure**: Quarterly financial reports + annual third-party audit
- **Board Seat**: Lead investor (>$1M) receives Foundation board observer/member seat
- **Anti-dilution Protection**: Standard Web3 anti-dilution terms (broad-based weighted average)

### 9.4 Milestone-Based Release

To reduce investor risk, the $5M will be released in three tranches:

| Tranche | % | Amount | Trigger |
|---------|---|--------|---------|
| **First** | 40% | $2,000,000 | Released immediately on signing, for core team expansion and mainnet launch |
| **Second** | 35% | $1,750,000 | 30 days stable mainnet + 100+ nodes + 1K+ Agent registrations |
| **Third** | 25% | $1,250,000 | TVL exceeds $10M + 5+ Agent frameworks integrated |

### 9.5 Subsequent Funding Roadmap

Possible paths after Series A:

| Stage | Time | Size | Use |
|-------|------|------|-----|
| **Series B** | 2027 | $20M-$50M | Global expansion, enterprise BD, L2 deployments |
| **Token Public Sale** | 2027-2028 | Market-dependent | DEX/CEX listing, ecosystem liquidity release |
| **Strategic Round (optional)** | Open ongoing | Major AI enterprise strategic investment | Ecosystem binding |

---

## X. Milestones & Timeline

| Time | Milestone | Verification Metric |
|------|-----------|---------------------|
| **2026 Q2** | Mainnet genesis + 100 nodes + 10K Agents | 30 days stable mainnet |
| **2026 Q4** | SDK + first Grants + 50 Carriers | 5+ Agent frameworks integrated |
| **2027** | DAO live + 1K nodes + 500K Agents | TVL > $10M |
| **2028** | Commercial dApps + 5K nodes + 10M Agents | TVL > $100M |
| **2030** | One of AI industry standards + 20K nodes + 100M Agents | TVL > $1B |

---

## XI. Risks & Mitigation

### 11.1 Key Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| **AI Agent industry growth slower than expected** | Medium | Severe | Protocol neutrality; serves any Agent framework |
| **Strong competition emerges** | Medium | Medium | First-mover + network effects + continued tech leadership |
| **Smart contract vulnerabilities** | Medium | Severe | Tier-1 audit + Bug Bounty + treasury reserve |
| **Regulatory uncertainty** | High | Medium | Multi-jurisdiction strategy + legal compliance |
| **Poor token liquidity** | Medium | Medium | DEX listing + cross-chain bridges + market makers |
| **Foundation governance failure** | Low | Severe | DAO checks + quarterly audits + transparency commitments |

### 11.2 Investor Exit Paths

1. **Token liquidity exit**: Direct trading after DEX/CEX listing
2. **Strategic acquisition**: Acquired by major AI company or L1 project
3. **Secondary market**: Negotiated transfer to other strategic buyers (within lockup)
4. **Protocol revenue sharing** (future option): Foundation revenue distributed pro-rata to holdings

---

## XII. Appendix: Key Links

| Resource | Link |
|----------|------|
| Technical Whitepaper | `docs/COC_whitepaper.en.md` / `.zh.md` |
| Ecosystem Roadmap | `docs/COC_ecosystem_roadmap.en.md` / `.zh.md` |
| Code Repository | `github.com/NGPlateform/coc-dev` (private) |
| Official Domain | `clawchain.io` |
| Contact Email | (TBD) |
| Discord/Telegram | (TBD) |

---

## Document Notes

This business plan integrates product, technology, market opportunity, tokenomics, funding target, and founding team into a complete document — ready for strategic investor communication.

This document can serve as:
- Core material for initial strategic investor communication
- Source content for the Pitch Deck
- Internal execution baseline for fundraising preparation

**Next Steps**:
1. Finalize valuation terms (pre-money valuation, token price, SAFT template)
2. Finalize accompanying Pitch Deck (20-slide PPT, English draft already exists)
3. Prepare Data Room: audit reports, legal opinions, technical validation, team KYC
4. Begin one-on-one outreach to strategic investors
