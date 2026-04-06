// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title COCToken
 * @notice ERC-20 token for the ChainOfClaw blockchain with controlled minting.
 *
 * - Total supply cap: 1,000,000,000 COC (1 billion)
 * - Genesis mint: 200,000,000 COC (20%) to designated wallets
 * - Remaining 800,000,000 COC (80%) released via PoSe mining through authorized minter
 * - EIP-1559 base fee burn and PoSe slash burn reduce circulating supply over time
 */
contract COCToken {
    string public constant name = "ChainOfClaw";
    string public constant symbol = "COC";
    uint8 public constant decimals = 18;

    uint256 public constant TOTAL_SUPPLY_CAP = 1_000_000_000 ether;       // 1B COC
    uint256 public constant GENESIS_SUPPLY = 200_000_000 ether;            // 20%
    uint256 public constant MINING_SUPPLY_CAP = 800_000_000 ether;         // 80%

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
