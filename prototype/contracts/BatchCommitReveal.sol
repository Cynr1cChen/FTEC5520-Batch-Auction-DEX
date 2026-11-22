// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20Lite} from "./BatchAuctionDEX.sol";

/// @notice A single-window commit/reveal escrow experiment for the local mock pair.
/// @dev Trader, side, and amount are public at commit. MinOut is committed with a secret salt.
///      Reveal publishes minOut. Every order can reclaim its original escrow after the reveal window.
///      This experiment records order disclosure and refunds; it does not execute trades.
contract BatchCommitReveal {
    struct Entry {
        address trader;
        bool isBuyETH;
        bool revealed;
        bool claimed;
        uint256 amountIn;
        bytes32 commitment;
        uint256 minOut;
    }

    IERC20Lite public immutable eth;
    IERC20Lite public immutable usdc;
    uint256 public immutable commitEnd;
    uint256 public immutable revealEnd;
    Entry[] public entries;

    error InvalidConfiguration();
    error InvalidEntry();
    error CommitWindowClosed();
    error RevealWindowClosed();
    error RefundWindowNotOpen();
    error NotTrader();
    error AlreadyRevealed();
    error InvalidOpening();
    error AlreadyClaimed();
    error TransferFailed();

    event OrderCommitted(
        uint256 indexed id, address indexed trader, bool isBuyETH, uint256 amountIn, bytes32 commitment
    );
    event OrderOpened(uint256 indexed id, uint256 minOut);
    event EscrowRefunded(uint256 indexed id, bool revealed, uint256 amountIn);

    constructor(address ethToken, address usdcToken, uint256 commitDuration, uint256 revealDuration) {
        if (
            ethToken == address(0) || usdcToken == address(0) || ethToken == usdcToken
                || commitDuration == 0 || revealDuration == 0
        ) revert InvalidConfiguration();
        eth = IERC20Lite(ethToken);
        usdc = IERC20Lite(usdcToken);
        commitEnd = block.timestamp + commitDuration;
        revealEnd = commitEnd + revealDuration;
    }

    function computeCommitment(address trader, bool isBuyETH, uint256 amountIn, uint256 minOut, bytes32 salt)
        public view returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), trader, isBuyETH, amountIn, minOut, salt));
    }

    function commit(bool isBuyETH, uint256 amountIn, bytes32 commitment) external returns (uint256 id) {
        if (block.timestamp >= commitEnd) revert CommitWindowClosed();
        if (amountIn == 0 || commitment == bytes32(0)) revert InvalidEntry();

        id = entries.length;
        entries.push(Entry({
            trader: msg.sender,
            isBuyETH: isBuyETH,
            revealed: false,
            claimed: false,
            amountIn: amountIn,
            commitment: commitment,
            minOut: 0
        }));
        IERC20Lite token = isBuyETH ? usdc : eth;
        if (!token.transferFrom(msg.sender, address(this), amountIn)) revert TransferFailed();
        emit OrderCommitted(id, msg.sender, isBuyETH, amountIn, commitment);
    }

    function reveal(uint256 id, uint256 minOut, bytes32 salt) external {
        if (block.timestamp < commitEnd || block.timestamp >= revealEnd) revert RevealWindowClosed();
        Entry storage entry = _ownEntry(id);
        if (entry.revealed) revert AlreadyRevealed();
        if (computeCommitment(entry.trader, entry.isBuyETH, entry.amountIn, minOut, salt) != entry.commitment) {
            revert InvalidOpening();
        }
        entry.minOut = minOut;
        entry.revealed = true;
        emit OrderOpened(id, minOut);
    }

    function refund(uint256 id) external {
        if (block.timestamp < revealEnd) revert RefundWindowNotOpen();
        Entry storage entry = _ownEntry(id);
        if (entry.claimed) revert AlreadyClaimed();
        entry.claimed = true;
        IERC20Lite token = entry.isBuyETH ? usdc : eth;
        if (!token.transfer(msg.sender, entry.amountIn)) revert TransferFailed();
        emit EscrowRefunded(id, entry.revealed, entry.amountIn);
    }

    function _ownEntry(uint256 id) private view returns (Entry storage entry) {
        if (id >= entries.length) revert InvalidEntry();
        entry = entries[id];
        if (entry.trader != msg.sender) revert NotTrader();
    }
}
