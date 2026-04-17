// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MultiSigWallet
 * @dev N-of-M multisig wallet for EVM compatibility testing.
 *      Exercises multi-account interaction, complex storage, and ETH transfers.
 */
contract MultiSigWallet {
    struct Transaction {
        address to;
        uint256 value;
        bytes data;
        bool executed;
        uint256 confirmCount;
    }

    address[] public owners;
    uint256 public required;
    Transaction[] public transactions;

    mapping(address => bool) public isOwner;
    mapping(uint256 => mapping(address => bool)) public isConfirmed;

    event Deposit(address indexed sender, uint256 amount);
    event Submit(uint256 indexed txId, address indexed to, uint256 value);
    event Confirm(uint256 indexed txId, address indexed owner);
    event Revoke(uint256 indexed txId, address indexed owner);
    event Execute(uint256 indexed txId);

    modifier onlyOwner() {
        require(isOwner[msg.sender], "Not owner");
        _;
    }

    modifier txExists(uint256 txId) {
        require(txId < transactions.length, "Tx does not exist");
        _;
    }

    modifier notExecuted(uint256 txId) {
        require(!transactions[txId].executed, "Already executed");
        _;
    }

    constructor(address[] memory _owners, uint256 _required) {
        require(_owners.length > 0, "Owners required");
        require(_required > 0 && _required <= _owners.length, "Invalid required count");

        for (uint256 i = 0; i < _owners.length; i++) {
            address o = _owners[i];
            require(o != address(0), "Invalid owner");
            require(!isOwner[o], "Duplicate owner");
            isOwner[o] = true;
            owners.push(o);
        }
        required = _required;
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    function submitTransaction(address to, uint256 value, bytes calldata data) external onlyOwner returns (uint256 txId) {
        txId = transactions.length;
        transactions.push(Transaction({
            to: to,
            value: value,
            data: data,
            executed: false,
            confirmCount: 0
        }));
        emit Submit(txId, to, value);
    }

    function confirmTransaction(uint256 txId) external onlyOwner txExists(txId) notExecuted(txId) {
        require(!isConfirmed[txId][msg.sender], "Already confirmed");

        isConfirmed[txId][msg.sender] = true;
        transactions[txId].confirmCount += 1;
        emit Confirm(txId, msg.sender);
    }

    function executeTransaction(uint256 txId) external onlyOwner txExists(txId) notExecuted(txId) {
        Transaction storage t = transactions[txId];
        require(t.confirmCount >= required, "Not enough confirmations");

        t.executed = true;

        (bool success, ) = t.to.call{value: t.value}(t.data);
        require(success, "Execution failed");

        emit Execute(txId);
    }

    function revokeConfirmation(uint256 txId) external onlyOwner txExists(txId) notExecuted(txId) {
        require(isConfirmed[txId][msg.sender], "Not confirmed");

        isConfirmed[txId][msg.sender] = false;
        transactions[txId].confirmCount -= 1;
        emit Revoke(txId, msg.sender);
    }

    function getTransactionCount() external view returns (uint256) {
        return transactions.length;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }
}
