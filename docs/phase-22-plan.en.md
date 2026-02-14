# Phase 22: Validator Governance

## Overview

Phase 22 adds a validator governance system with proposal-based validator set management, stake-weighted voting, and epoch-based transitions.

## Components

### ValidatorGovernance (`validator-governance.ts`)

**Validator Management:**
- Genesis validator initialization with stake amounts
- Stake-weighted voting power calculation (proportional to stake)
- Active/inactive validator tracking

**Proposal System:**
- `add_validator`: add new validator (requires address + minimum stake)
- `remove_validator`: remove validator (cannot remove last one)
- `update_stake`: modify validator stake amount
- Proposer must be active validator
- Proposer auto-votes yes on their proposal

**Voting:**
- Each active validator can vote approve/reject
- Stake-weighted voting power determines outcome
- Configurable approval threshold (default 67%)
- Minimum participation requirement (default 50%)
- Proposal auto-resolves when threshold is met

**Lifecycle:**
- Proposals expire after configurable epoch duration (default 24 epochs)
- `advanceEpoch()` processes expired proposals
- Status: pending → approved/rejected/expired

### Configuration
- `minStake`: minimum stake for validators (default 1 ETH)
- `maxValidators`: maximum validator set size (default 100)
- `proposalDurationEpochs`: proposal expiry (default 24)
- `approvalThresholdPercent`: approval voting power needed (default 67%)
- `minVoterPercent`: minimum participation (default 50%)

## Test Coverage

- `validator-governance.test.ts`: 15 tests (all passing)
- Covers: genesis init, voting power, proposal CRUD, approval/rejection, expiry, removal, stake update, power recalc, status filtering

## Status: Complete
