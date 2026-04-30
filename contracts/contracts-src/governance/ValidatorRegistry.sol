// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ValidatorRegistry
 * @notice On-chain BFT validator set with stake, lockup-protected unstake,
 *         and slashing. Sprint 3 of Phase F+G in
 *         /home/baominghao/.claude/plans/coc-evm-abstract-turtle.md.
 *
 *         Decoupled from PoSeManagerV2: validator status here is the BFT
 *         truth that node-side ValidatorRegistryReader (Sprint 4) consumes
 *         to drive `BftCoordinator.updateValidators`. PoSe's NodeRecord
 *         continues to track *PoSe roles* (challenger / aggregator /
 *         storage), which are orthogonal to the BFT consensus set.
 *
 *         nodeId convention (matches PoSeManagerV2 + COC BFT signer ids):
 *             nodeId = keccak256(uncompressedPubkey[1:65])
 *         where pubkeyNode is the 65-byte secp256k1 pubkey (0x04 || X || Y).
 *         The trailing 20 bytes of nodeId are the validator's EVM address
 *         (the same id BFT messages carry as senderId).
 *
 *         Permissionless register/withdraw, role-gated slash:
 *           - stake/requestUnstake/withdrawStake: anyone, scoped to the
 *             operator that posted the stake.
 *           - slashValidator: only the configured `slasher` address (the
 *             deployer initially; transferable). Future work can replace
 *             this with on-chain equivocation evidence checked by an
 *             EquivocationDetector contract — left for a later sprint.
 *           - setSlasher / setSlashRecipient / transferOwnership: only
 *             owner.
 *
 *         Constants (immutable after deploy; tweak at deploy time only):
 *           MIN_STAKE         32 ether
 *           UNSTAKE_LOCKUP    14 days
 *           MAX_VALIDATORS    21
 *           SLASH_BPS         1000  (10% of remaining stake per slash)
 */
contract ValidatorRegistry {
    // ── Constants ────────────────────────────────────────────────────────

    uint256 public constant MIN_STAKE = 32 ether;
    uint256 public constant UNSTAKE_LOCKUP = 14 days;
    uint256 public constant MAX_VALIDATORS = 21;
    uint16 public constant SLASH_BPS = 1000; // 10%
    uint16 public constant BPS_DENOM = 10_000;

    // Phase I5: when `insuranceFund` is set, slashed amounts split
    // 50% burn / 30% reporter (slashRecipient) / 20% insurance — matches
    // PoSeManagerV2's slash distribution. When `insuranceFund` is the zero
    // address, falls back to legacy 100%-to-slashRecipient behaviour so
    // existing deployments are unaffected until an owner opts in via
    // `setInsuranceFund`.
    uint16 public constant SLASH_BURN_SHARE_BPS = 5000;     // 50%
    uint16 public constant SLASH_REPORTER_SHARE_BPS = 3000; // 30%
    // Insurance share = BPS_DENOM - SLASH_BURN_SHARE_BPS - SLASH_REPORTER_SHARE_BPS = 2000.

    // ── Data ─────────────────────────────────────────────────────────────

    /**
     * @dev `pubkeyNode` is intentionally NOT stored on-chain — keeping a
     *      65 B `bytes` field in the struct pushes register gas above the
     *      200k Sprint 3 budget without adding on-chain functionality.
     *      Off-chain readers (Sprint 4 ValidatorRegistryReader) reconstruct
     *      the pubkey from the `ValidatorRegistered` event log, which keeps
     *      the bytes in calldata-priced log storage.
     *
     *      The contract still validates `keccak256(pubkey[1:]) == nodeId`
     *      at register time, so the on-chain nodeId is a verified anchor
     *      to the off-chain pubkey.
     */
    struct Validator {
        bytes32 nodeId;
        address operator;
        uint256 stake;
        uint64 registeredAt;
        uint64 unstakeRequestedAt; // 0 if not requested
        bool active;
    }

    /// @dev nodeId → record. Slot stays populated after deactivation so the
    ///      operator can withdraw remaining stake; cleared on full withdraw.
    mapping(bytes32 => Validator) private _validators;

    /// @dev Active set, swap-pop maintained. `getActiveValidators()` returns
    ///      this directly. Deactivation removes; re-staking is currently
    ///      not allowed (would require a fresh nodeId or governance reset).
    bytes32[] private _activeNodeIds;

    /// @dev nodeId → 1-based index into `_activeNodeIds` (0 means not active).
    mapping(bytes32 => uint256) private _activeIndex;

    // ── Roles ────────────────────────────────────────────────────────────

    address public owner;
    address public slasher;
    address public slashRecipient;
    // Phase I5: optional split-routing addresses. When `insuranceFund == 0`,
    // legacy 100%-to-slashRecipient applies; when set, 50/30/20 split fires.
    // `burnSink` defaults to 0x000...dEaD on first setInsuranceFund call so
    // burn truly leaves circulation; owner can override.
    address public insuranceFund;
    address public burnSink;

    // ── Events ───────────────────────────────────────────────────────────

    event ValidatorRegistered(
        bytes32 indexed nodeId,
        address indexed operator,
        uint256 stake,
        bytes pubkeyNode
    );
    event ValidatorActivated(bytes32 indexed nodeId);
    event ValidatorDeactivated(bytes32 indexed nodeId, uint64 unstakeRequestedAt);
    event ValidatorWithdrew(bytes32 indexed nodeId, address indexed operator, uint256 amount);
    event ValidatorSlashed(bytes32 indexed nodeId, uint256 amount, bytes32 indexed reason);
    // Phase I5: surfaces the 50/30/20 split when insuranceFund is set so
    // off-chain accounting can attribute by share.
    event SlashDistributed(
        bytes32 indexed nodeId,
        uint256 burnAmount,
        uint256 reporterAmount,
        uint256 insuranceAmount
    );

    event SlasherUpdated(address indexed oldSlasher, address indexed newSlasher);
    event SlashRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event InsuranceFundUpdated(address indexed oldFund, address indexed newFund);
    event BurnSinkUpdated(address indexed oldSink, address indexed newSink);
    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);

    // ── Errors ───────────────────────────────────────────────────────────

    error NodeIdMismatch(bytes32 expected, bytes32 actual);
    error StakeTooLow(uint256 provided, uint256 required);
    error AlreadyRegistered(bytes32 nodeId);
    error NotRegistered(bytes32 nodeId);
    error ValidatorSetFull(uint256 cap);
    error NotOperator(bytes32 nodeId, address caller, address operator);
    error NotActive(bytes32 nodeId);
    error AlreadyDeactivated(bytes32 nodeId);
    error StillLockedUp(uint64 unlockTime);
    error InvalidPubkey(uint256 length);
    error OnlySlasher();
    error OnlyOwner();
    error TransferFailed();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        slasher = msg.sender;
        slashRecipient = msg.sender;
    }

    // ── Stake / activate ─────────────────────────────────────────────────

    /**
     * @notice Stake to become a BFT validator. Permissionless: anyone can
     *         register a (nodeId, pubkey) pair so long as
     *         `keccak256(pubkey[1:])` == `nodeId`. Re-registering an existing
     *         (active or pending-withdraw) nodeId reverts.
     *
     *         Activates immediately when stake >= MIN_STAKE and the active set
     *         has room (active count < MAX_VALIDATORS). The msg.sender becomes
     *         the operator; only the operator can later request unstake or
     *         withdraw.
     *
     * @param nodeId      keccak256(uncompressedPubkey[1:65]) — must match
     *                    `pubkeyNode` or this reverts. Conventional
     *                    `address(uint160(uint256(nodeId)))` is the EVM
     *                    address derived from the pubkey.
     * @param pubkeyNode  65-byte uncompressed secp256k1 pubkey (0x04 || X || Y).
     */
    function stake(bytes32 nodeId, bytes calldata pubkeyNode) external payable {
        if (pubkeyNode.length != 65) revert InvalidPubkey(pubkeyNode.length);
        // Skip the 0x04 prefix byte: nodeId = keccak256(X || Y).
        bytes32 derived = keccak256(pubkeyNode[1:]);
        if (derived != nodeId) revert NodeIdMismatch(nodeId, derived);
        if (msg.value < MIN_STAKE) revert StakeTooLow(msg.value, MIN_STAKE);
        if (_validators[nodeId].operator != address(0)) revert AlreadyRegistered(nodeId);
        if (_activeNodeIds.length >= MAX_VALIDATORS) revert ValidatorSetFull(MAX_VALIDATORS);

        _validators[nodeId] = Validator({
            nodeId: nodeId,
            operator: msg.sender,
            stake: msg.value,
            registeredAt: uint64(block.timestamp),
            unstakeRequestedAt: 0,
            active: true
        });

        _activeNodeIds.push(nodeId);
        _activeIndex[nodeId] = _activeNodeIds.length; // 1-based

        emit ValidatorRegistered(nodeId, msg.sender, msg.value, pubkeyNode);
        emit ValidatorActivated(nodeId);
    }

    // ── Unstake / withdraw ───────────────────────────────────────────────

    /**
     * @notice Operator-initiated unstake request. Removes the validator from
     *         the active BFT set immediately and starts the lockup clock.
     *         Stake stays held by the contract until `withdrawStake()` is
     *         called after `UNSTAKE_LOCKUP` has elapsed. Slashing is still
     *         possible during the lockup window (intentional — lets evidence
     *         emerge after a misbehaving validator tries to exit).
     */
    function requestUnstake(bytes32 nodeId) external {
        Validator storage v = _validators[nodeId];
        if (v.operator == address(0)) revert NotRegistered(nodeId);
        if (v.operator != msg.sender) revert NotOperator(nodeId, msg.sender, v.operator);
        if (!v.active) revert AlreadyDeactivated(nodeId);

        v.active = false;
        v.unstakeRequestedAt = uint64(block.timestamp);
        _removeFromActive(nodeId);

        emit ValidatorDeactivated(nodeId, v.unstakeRequestedAt);
    }

    /**
     * @notice Operator-initiated withdrawal after lockup. Sends remaining
     *         stake to the operator and deletes the registry entry. Stake
     *         may be less than the original deposit if slash events occurred
     *         before withdrawal.
     */
    function withdrawStake(bytes32 nodeId) external {
        Validator storage v = _validators[nodeId];
        if (v.operator == address(0)) revert NotRegistered(nodeId);
        if (v.operator != msg.sender) revert NotOperator(nodeId, msg.sender, v.operator);
        if (v.active) revert NotActive(nodeId); // active means unstake not yet requested

        uint64 unlockAt = v.unstakeRequestedAt + uint64(UNSTAKE_LOCKUP);
        if (block.timestamp < unlockAt) revert StillLockedUp(unlockAt);

        uint256 amount = v.stake;
        address payable operator = payable(v.operator);
        delete _validators[nodeId];

        if (amount > 0) {
            (bool ok, ) = operator.call{ value: amount }("");
            if (!ok) revert TransferFailed();
        }

        emit ValidatorWithdrew(nodeId, operator, amount);
    }

    // ── Slash ────────────────────────────────────────────────────────────

    /**
     * @notice Slash a validator. Only the configured `slasher` address may
     *         call. Takes `SLASH_BPS / BPS_DENOM` of the validator's
     *         remaining stake and forwards it to `slashRecipient`. If the
     *         validator was active, also removes it from the BFT set.
     *
     *         `reason` is an opaque bytes32 (e.g. evidence-hash) recorded in
     *         the event for audit. Future work: an EquivocationDetector
     *         contract that supplies on-chain proof, called via this same
     *         entry point with `slasher` set to the detector.
     */
    function slashValidator(bytes32 nodeId, bytes32 reason) external {
        if (msg.sender != slasher) revert OnlySlasher();
        Validator storage v = _validators[nodeId];
        if (v.operator == address(0)) revert NotRegistered(nodeId);

        uint256 slashAmount = (v.stake * SLASH_BPS) / BPS_DENOM;
        if (slashAmount > v.stake) slashAmount = v.stake; // belt-and-suspenders
        v.stake -= slashAmount;

        if (v.active) {
            v.active = false;
            v.unstakeRequestedAt = uint64(block.timestamp);
            _removeFromActive(nodeId);
            emit ValidatorDeactivated(nodeId, v.unstakeRequestedAt);
        }

        if (slashAmount > 0) {
            if (insuranceFund != address(0)) {
                // Phase I5: 50% burn / 30% reporter / 20% insurance split.
                uint256 burnShare = (slashAmount * SLASH_BURN_SHARE_BPS) / BPS_DENOM;
                uint256 reporterShare = (slashAmount * SLASH_REPORTER_SHARE_BPS) / BPS_DENOM;
                uint256 insuranceShare = slashAmount - burnShare - reporterShare;
                address effectiveBurnSink = burnSink == address(0)
                    ? address(0x000000000000000000000000000000000000dEaD)
                    : burnSink;
                if (burnShare > 0) {
                    (bool okB, ) = payable(effectiveBurnSink).call{ value: burnShare }("");
                    if (!okB) revert TransferFailed();
                }
                if (reporterShare > 0) {
                    (bool okR, ) = payable(slashRecipient).call{ value: reporterShare }("");
                    if (!okR) revert TransferFailed();
                }
                if (insuranceShare > 0) {
                    (bool okI, ) = payable(insuranceFund).call{ value: insuranceShare }("");
                    if (!okI) revert TransferFailed();
                }
                emit SlashDistributed(nodeId, burnShare, reporterShare, insuranceShare);
            } else {
                // Legacy: 100% to slashRecipient. Deployments that haven't
                // configured insuranceFund retain pre-I5 behaviour.
                (bool ok, ) = payable(slashRecipient).call{ value: slashAmount }("");
                if (!ok) revert TransferFailed();
            }
        }

        emit ValidatorSlashed(nodeId, slashAmount, reason);
    }

    // ── Views ────────────────────────────────────────────────────────────

    function getActiveValidators() external view returns (bytes32[] memory) {
        return _activeNodeIds;
    }

    function activeValidatorCount() external view returns (uint256) {
        return _activeNodeIds.length;
    }

    function getValidator(bytes32 nodeId) external view returns (Validator memory) {
        return _validators[nodeId];
    }

    function isActive(bytes32 nodeId) external view returns (bool) {
        return _validators[nodeId].active;
    }

    // ── Owner ops ────────────────────────────────────────────────────────

    function setSlasher(address newSlasher) external onlyOwner {
        if (newSlasher == address(0)) revert ZeroAddress();
        emit SlasherUpdated(slasher, newSlasher);
        slasher = newSlasher;
    }

    function setSlashRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit SlashRecipientUpdated(slashRecipient, newRecipient);
        slashRecipient = newRecipient;
    }

    /**
     * @notice Phase I5: Configure the insurance fund sink. Setting a non-zero
     *         address activates the 50/30/20 burn/reporter/insurance split on
     *         all subsequent slashes. Setting back to zero falls back to
     *         legacy 100%-to-slashRecipient behaviour.
     */
    function setInsuranceFund(address newFund) external onlyOwner {
        emit InsuranceFundUpdated(insuranceFund, newFund);
        insuranceFund = newFund;
    }

    /**
     * @notice Phase I5: Override the burn sink (default 0x000...dEaD). Useful
     *         on testnets that prefer the burn share routed to a treasury
     *         address rather than a true dead address.
     */
    function setBurnSink(address newSink) external onlyOwner {
        emit BurnSinkUpdated(burnSink, newSink);
        burnSink = newSink;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    // ── Internal ─────────────────────────────────────────────────────────

    function _removeFromActive(bytes32 nodeId) internal {
        uint256 idx1 = _activeIndex[nodeId];
        if (idx1 == 0) return; // not active
        uint256 idx = idx1 - 1;
        uint256 last = _activeNodeIds.length - 1;
        if (idx != last) {
            bytes32 movedId = _activeNodeIds[last];
            _activeNodeIds[idx] = movedId;
            _activeIndex[movedId] = idx + 1;
        }
        _activeNodeIds.pop();
        delete _activeIndex[nodeId];
    }

    receive() external payable {
        // Reject stray ETH — staking must go through stake() so the
        // Validator record gets created. Anything else is a misuse.
        revert();
    }
}
