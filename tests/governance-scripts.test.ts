/**
 * Tests for governance proposal and vote scripts
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

// Import validation logic from scripts
import { validateConfig as validateProposal, type ProposalConfig } from "../scripts/submit-proposal.ts"
import { validateConfig as validateVote, type VoteConfig } from "../scripts/vote-proposal.ts"

describe("submit-proposal validation", () => {
  it("accepts valid add_validator proposal", () => {
    const config: ProposalConfig = {
      rpcUrl: "http://127.0.0.1:18780",
      type: "add_validator",
      targetId: "validator-4",
      proposer: "validator-1",
      targetAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      stakeAmount: "1000000000000000000",
    }
    assert.equal(validateProposal(config), null)
  })

  it("accepts valid remove_validator proposal", () => {
    const config: ProposalConfig = {
      rpcUrl: "http://127.0.0.1:18780",
      type: "remove_validator",
      targetId: "validator-3",
      proposer: "validator-1",
    }
    assert.equal(validateProposal(config), null)
  })

  it("accepts valid update_stake proposal", () => {
    const config: ProposalConfig = {
      rpcUrl: "http://127.0.0.1:18780",
      type: "update_stake",
      targetId: "validator-2",
      proposer: "validator-1",
      stakeAmount: "5000000000000000000",
    }
    assert.equal(validateProposal(config), null)
  })

  it("rejects missing type", () => {
    const config: ProposalConfig = {
      rpcUrl: "http://127.0.0.1:18780",
      type: "",
      targetId: "v1",
      proposer: "v2",
    }
    assert.match(validateProposal(config)!, /Missing --type/)
  })

  it("rejects invalid type", () => {
    const config: ProposalConfig = {
      rpcUrl: "http://127.0.0.1:18780",
      type: "invalid_type",
      targetId: "v1",
      proposer: "v2",
    }
    assert.match(validateProposal(config)!, /Invalid type/)
  })

  it("rejects missing target-id", () => {
    const config: ProposalConfig = {
      rpcUrl: "http://127.0.0.1:18780",
      type: "remove_validator",
      targetId: "",
      proposer: "v1",
    }
    assert.match(validateProposal(config)!, /Missing --target-id/)
  })

  it("rejects missing proposer", () => {
    const config: ProposalConfig = {
      rpcUrl: "http://127.0.0.1:18780",
      type: "remove_validator",
      targetId: "v1",
      proposer: "",
    }
    assert.match(validateProposal(config)!, /Missing --proposer/)
  })

  it("requires target-address for add_validator", () => {
    const config: ProposalConfig = {
      rpcUrl: "http://127.0.0.1:18780",
      type: "add_validator",
      targetId: "v4",
      proposer: "v1",
      stakeAmount: "1000",
    }
    assert.match(validateProposal(config)!, /requires --target-address/)
  })

  it("requires stake-amount for add_validator", () => {
    const config: ProposalConfig = {
      rpcUrl: "http://127.0.0.1:18780",
      type: "add_validator",
      targetId: "v4",
      proposer: "v1",
      targetAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    }
    assert.match(validateProposal(config)!, /requires --stake-amount/)
  })

  it("rejects invalid address format", () => {
    const config: ProposalConfig = {
      rpcUrl: "http://127.0.0.1:18780",
      type: "add_validator",
      targetId: "v4",
      proposer: "v1",
      targetAddress: "not-an-address",
      stakeAmount: "1000",
    }
    assert.match(validateProposal(config)!, /Invalid --target-address/)
  })
})

describe("vote-proposal validation", () => {
  it("accepts valid vote config", () => {
    const config: VoteConfig = {
      rpcUrl: "http://127.0.0.1:18780",
      proposalId: "prop-1",
      voterId: "validator-1",
      approve: true,
    }
    assert.equal(validateVote(config), null)
  })

  it("accepts reject vote", () => {
    const config: VoteConfig = {
      rpcUrl: "http://127.0.0.1:18780",
      proposalId: "prop-1",
      voterId: "validator-2",
      approve: false,
    }
    assert.equal(validateVote(config), null)
  })

  it("rejects missing proposal-id", () => {
    const config: VoteConfig = {
      rpcUrl: "http://127.0.0.1:18780",
      proposalId: "",
      voterId: "v1",
      approve: true,
    }
    assert.match(validateVote(config)!, /Missing --proposal-id/)
  })

  it("rejects missing voter", () => {
    const config: VoteConfig = {
      rpcUrl: "http://127.0.0.1:18780",
      proposalId: "prop-1",
      voterId: "",
      approve: true,
    }
    assert.match(validateVote(config)!, /Missing --voter/)
  })
})
