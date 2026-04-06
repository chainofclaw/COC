// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title COCToken
 * @notice Supply tracking and emission control for the COC native token.
 *
 * COC is the chain's native gas token (like BNB on BNB Chain). This contract
 * tracks supply accounting and controls PoSe mining emission — it does NOT handle
 * transfers (native token transfers use EVM's built-in value transfer mechanism).
 *
 * - Total supply cap: 1,000,000,000 COC (1 billion)
 * - Genesis mint: 250,000,000 COC (25%) to designated wallets
 * - Remaining 750,000,000 COC (75%) released via PoSe mining through authorized minter
 * - EIP-1559 base fee burn directly reduces native COC supply
 * - PoSe slash burn reduces circulating supply over time
 *
 * Note: In Solidity, `ether` keyword means 10^18 (the smallest unit), NOT Ethereum.
 * On this chain, 1 ether = 1 COC = 10^18 wei (COC's smallest unit).
 */
contract COCToken {
    string public constant name = "ChainOfClaw";
    string public constant symbol = "COC";
    uint8 public constant decimals = 18;

    uint256 public constant TOTAL_SUPPLY_CAP = 1_000_000_000 ether;       // 1B COC
    uint256 public constant GENESIS_SUPPLY = 250_000_000 ether;            // 25%
    uint256 public constant MINING_SUPPLY_CAP = 750_000_000 ether;         // 75%

    uint256 public totalSupply;
    uint256 public totalMinted;     // Cumulative mining emissions (excludes genesis)
    uint256 public totalBurned;

    address public owner;
    address public minter;          // PoSeManagerV2 — sole authorized minter

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MinterUpdated(address indexed oldMinter, address indexed newMinter);
    event Mint(address indexed to, uint256 amount);
    event Burn(address indexed from, uint256 amount);

    error ExceedsSupplyCap();
    error ExceedsMiningCap();
    error NotOwner();
    error NotMinter();
    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }

    /**
     * @param genesisRecipients  Addresses receiving genesis allocation
     * @param genesisAmounts     Amounts for each recipient (must sum to GENESIS_SUPPLY)
     */
    constructor(address[] memory genesisRecipients, uint256[] memory genesisAmounts) {
        require(genesisRecipients.length == genesisAmounts.length, "length mismatch");
        owner = msg.sender;

        uint256 genesisTotal = 0;
        for (uint256 i = 0; i < genesisRecipients.length; i++) {
            if (genesisRecipients[i] == address(0)) revert ZeroAddress();
            balanceOf[genesisRecipients[i]] += genesisAmounts[i];
            genesisTotal += genesisAmounts[i];
            emit Transfer(address(0), genesisRecipients[i], genesisAmounts[i]);
        }
        require(genesisTotal == GENESIS_SUPPLY, "genesis total must equal GENESIS_SUPPLY");
        totalSupply = GENESIS_SUPPLY;
    }

    // ── Minter Management ──────────────────────────────────────────

    function setMinter(address newMinter) external onlyOwner {
        emit MinterUpdated(minter, newMinter);
        minter = newMinter;
    }

    // ── Mining Emission (called by PoSeManagerV2) ──────────────────

    /**
     * @notice Mint new tokens for PoSe mining rewards.
     * @dev Only callable by the authorized minter (PoSeManagerV2).
     *      Enforces MINING_SUPPLY_CAP — reverts if cumulative minting would exceed 800M.
     */
    function mint(address to, uint256 amount) external onlyMinter {
        if (to == address(0)) revert ZeroAddress();
        if (totalMinted + amount > MINING_SUPPLY_CAP) revert ExceedsMiningCap();
        if (totalSupply + amount > TOTAL_SUPPLY_CAP) revert ExceedsSupplyCap();

        totalMinted += amount;
        totalSupply += amount;
        balanceOf[to] += amount;

        emit Mint(to, amount);
        emit Transfer(address(0), to, amount);
    }

    // ── Burn ────────────────────────────────────────────────────────

    function burn(uint256 amount) external {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        totalBurned += amount;

        emit Burn(msg.sender, amount);
        emit Transfer(msg.sender, address(0), amount);
    }

    function burnFrom(address from, uint256 amount) external {
        if (allowance[from][msg.sender] < amount) revert InsufficientAllowance();
        if (balanceOf[from] < amount) revert InsufficientBalance();

        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        totalSupply -= amount;
        totalBurned += amount;

        emit Burn(from, amount);
        emit Transfer(from, address(0), amount);
    }

    // ── Standard ERC-20 ─────────────────────────────────────────────

    function transfer(address to, uint256 amount) external returns (bool) {
        if (to == address(0)) revert ZeroAddress();
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();

        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;

        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (to == address(0)) revert ZeroAddress();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        if (allowance[from][msg.sender] < amount) revert InsufficientAllowance();

        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;

        emit Transfer(from, to, amount);
        return true;
    }

    // ── View Helpers ────────────────────────────────────────────────

    function remainingMiningSupply() external view returns (uint256) {
        return MINING_SUPPLY_CAP - totalMinted;
    }

    function circulatingSupply() external view returns (uint256) {
        return totalSupply;
    }
}
