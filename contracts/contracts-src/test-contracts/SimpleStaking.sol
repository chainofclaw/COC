// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SimpleStaking
 * @dev Simplified staking contract for EVM compatibility testing.
 *      Users stake native ETH/COC, earn linear time-based rewards.
 */
contract SimpleStaking {
    struct StakeInfo {
        uint256 amount;
        uint256 stakedAt;
        uint256 rewardsClaimed;
    }

    uint256 public constant REWARD_RATE = 1e15; // 0.001 ETH per ETH per hour
    uint256 public totalStaked;
    address public owner;

    mapping(address => StakeInfo) public stakes;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event RewardClaimed(address indexed user, uint256 reward);

    constructor() {
        owner = msg.sender;
    }

    function stake() external payable {
        require(msg.value > 0, "Must stake non-zero amount");

        StakeInfo storage info = stakes[msg.sender];
        if (info.amount > 0) {
            _claimRewards(msg.sender);
        }
        info.amount += msg.value;
        info.stakedAt = block.timestamp;
        totalStaked += msg.value;

        emit Staked(msg.sender, msg.value);
    }

    function unstake(uint256 amount) external {
        StakeInfo storage info = stakes[msg.sender];
        require(info.amount >= amount, "Insufficient staked balance");
        require(amount > 0, "Must unstake non-zero amount");

        _claimRewards(msg.sender);
        info.amount -= amount;
        totalStaked -= amount;

        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "ETH transfer failed");

        emit Unstaked(msg.sender, amount);
    }

    function claimRewards() external {
        _claimRewards(msg.sender);
    }

    function pendingRewards(address user) public view returns (uint256) {
        StakeInfo storage info = stakes[user];
        if (info.amount == 0) return 0;
        uint256 elapsed = block.timestamp - info.stakedAt;
        return (info.amount * REWARD_RATE * elapsed) / (1 ether * 3600);
    }

    function getStakeInfo(address user) external view returns (uint256 amount, uint256 stakedAt, uint256 rewardsClaimed, uint256 pending) {
        StakeInfo storage info = stakes[user];
        return (info.amount, info.stakedAt, info.rewardsClaimed, pendingRewards(user));
    }

    function _claimRewards(address user) internal {
        uint256 reward = pendingRewards(user);
        if (reward == 0) return;

        StakeInfo storage info = stakes[user];
        info.rewardsClaimed += reward;
        info.stakedAt = block.timestamp;

        // Rewards paid from contract balance (funded by owner)
        if (address(this).balance >= reward) {
            (bool sent, ) = payable(user).call{value: reward}("");
            require(sent, "Reward transfer failed");
            emit RewardClaimed(user, reward);
        }
    }

    // Owner can fund the contract for rewards
    receive() external payable {}
}
