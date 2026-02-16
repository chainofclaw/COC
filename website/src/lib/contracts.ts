/// Contract ABIs and address configuration for governance contracts

export const FACTION_REGISTRY_ABI = [
  'function registerHuman() external',
  'function registerClaw(bytes32 agentId, bytes calldata attestation) external',
  'function verify(address account) external',
  'function getFaction(address account) external view returns (uint8)',
  'function getIdentity(address account) external view returns (tuple(uint8 faction, uint64 registeredAt, bytes32 attestationHash, bool verified))',
  'function isRegistered(address account) external view returns (bool)',
  'function isVerified(address account) external view returns (bool)',
  'function humanCount() external view returns (uint256)',
  'function clawCount() external view returns (uint256)',
  'event HumanRegistered(address indexed account, uint64 registeredAt)',
  'event ClawRegistered(address indexed account, bytes32 indexed agentId, uint64 registeredAt)',
  'event IdentityVerified(address indexed account, address indexed verifiedBy)',
] as const

export const GOVERNANCE_DAO_ABI = [
  'function createProposal(uint8 proposalType, string title, bytes32 descriptionHash, address executionTarget, bytes executionData, uint256 value) external returns (uint256)',
  'function vote(uint256 proposalId, uint8 support) external',
  'function queue(uint256 proposalId) external',
  'function execute(uint256 proposalId) external',
  'function cancel(uint256 proposalId) external',
  'function getProposal(uint256 proposalId) external view returns (tuple(uint256 id, uint8 proposalType, address proposer, string title, bytes32 descriptionHash, address executionTarget, bytes executionData, uint256 value, uint64 createdAt, uint64 votingDeadline, uint64 executionDeadline, uint256 forVotesHuman, uint256 againstVotesHuman, uint256 forVotesClaw, uint256 againstVotesClaw, uint256 abstainVotes, uint8 state))',
  'function getProposalState(uint256 proposalId) external view returns (uint8)',
  'function getVoteTotals(uint256 proposalId) external view returns (uint256, uint256, uint256, uint256, uint256)',
  'function proposalCount() external view returns (uint256)',
  'function hasVoted(uint256 proposalId, address voter) external view returns (bool)',
  'function votingPeriod() external view returns (uint64)',
  'function timelockDelay() external view returns (uint64)',
  'function quorumPercent() external view returns (uint256)',
  'function approvalPercent() external view returns (uint256)',
  'function bicameralEnabled() external view returns (bool)',
  'event ProposalCreated(uint256 indexed proposalId, address indexed proposer, uint8 proposalType, string title)',
  'event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint8 faction)',
  'event ProposalExecuted(uint256 indexed proposalId)',
] as const

export const TREASURY_ABI = [
  'function withdraw(address to, uint256 amount, uint256 proposalId) external',
  'function balance() external view returns (uint256)',
  'event Deposit(address indexed from, uint256 amount)',
  'event Withdrawal(address indexed to, uint256 amount, uint256 indexed proposalId)',
] as const

// Contract addresses - set via environment variables or defaults for local devnet
export function getContractAddresses() {
  return {
    factionRegistry: process.env.NEXT_PUBLIC_FACTION_REGISTRY_ADDRESS || '0x0000000000000000000000000000000000000000',
    governanceDAO: process.env.NEXT_PUBLIC_GOVERNANCE_DAO_ADDRESS || '0x0000000000000000000000000000000000000000',
    treasury: process.env.NEXT_PUBLIC_TREASURY_ADDRESS || '0x0000000000000000000000000000000000000000',
  }
}

export const PROPOSAL_TYPES = ['ValidatorAdd', 'ValidatorRemove', 'ParameterChange', 'TreasurySpend', 'ContractUpgrade', 'FreeText'] as const
export type ProposalType = typeof PROPOSAL_TYPES[number]

export const PROPOSAL_STATES = ['Pending', 'Approved', 'Rejected', 'Queued', 'Executed', 'Cancelled', 'Expired'] as const
export type ProposalState = typeof PROPOSAL_STATES[number]

export const FACTIONS = ['None', 'Human', 'Claw'] as const
export type Faction = typeof FACTIONS[number]
