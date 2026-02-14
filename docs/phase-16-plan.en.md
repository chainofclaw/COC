# Phase 16: P2P Discovery & Peer Scoring

## Overview

Phase 16 adds peer discovery via peer exchange protocol, reputation-based peer scoring with ban/unban mechanics, and health checking for the P2P networking layer.

## Components

### PeerScoring (`peer-scoring.ts`)
- Tracks reputation score per peer (0-200 range)
- Rewards successful interactions, penalizes failures/invalid data
- Automatic ban when score drops below threshold (30-min default)
- Score decay toward initial value over time
- Statistics API: total, active, banned, average score

### PeerDiscovery (`peer-discovery.ts`)
- Bootstrap from static config peers
- Periodic peer exchange: asks known peers for their peer lists
- Health checking with timeout-based failure detection
- Max peer limit to prevent resource exhaustion
- Self-exclusion from discovery results

### P2P Integration (`p2p.ts`)
- `/p2p/peers` endpoint for peer exchange
- Broadcasting uses active (non-banned) peers
- Scoring integrated into broadcast success/failure tracking
- Discovery and scoring auto-start with P2P server

## Test Coverage

- `peer-scoring.test.ts`: 17 tests (11 scoring + 6 discovery)
- All 81 tests pass

## Status: Complete
