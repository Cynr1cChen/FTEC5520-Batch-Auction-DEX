// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BatchAuctionDEX, IERC20Lite} from "./BatchAuctionDEX.sol";

interface IBalanceToken is IERC20Lite {
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Classroom extension for the project's standard mock assets and original pure solver.
/// @dev At most one previously excluded opt-in order is tried at its authorized minimum fill.
/// Up to four such trials are independently cleared. The trial with greatest CoW volume wins
/// only if it improves CoW volume and preserves the payouts of the original full fills.
contract BatchAuctionDEXPartialFill {
    enum Status { Pending, Settled, Refunded, Claimed, PartialFilled }

    struct Order {
        address trader;
        uint64 batchId;
        bool isBuyETH;
        Status status;
        uint256 amountIn;
        uint256 minOut;
        uint256 minFillIn;
        uint256 filledIn;
        uint256 receivedOut;
        uint256 refundedIn;
    }

    struct Batch {
        uint64 startTime;
        uint64 endTime;
        bool settled;
        uint256 totalBuyUSDC;
        uint256 totalSellETH;
        uint256 ethToBuyers;
        uint256 usdcToSellers;
        uint256 clearingPrice;
        uint256 cowUSDC;
        int256 poolDeltaETH;
        int256 poolDeltaUSDC;
        uint32 orderCount;
        uint32 refundedCount;
    }

    struct Clearing {
        BatchAuctionDEX.Solution solution;
        uint256[] fills;
        uint256[] payouts;
    }

    IBalanceToken public immutable eth;
    IBalanceToken public immutable usdc;
    BatchAuctionDEX public immutable solver;
    address public immutable initializer;
    uint256 public immutable batchDuration;
    uint256 public constant MAX_ORDERS_PER_BATCH = 50;
    uint256 public constant MAX_PARTIAL_ORDERS_PER_BATCH = 4;
    // Keep fee-adjusted amount/reserve and pro-rata products inside uint256.
    uint256 public constant MAX_TRACKED_ASSETS = type(uint112).max;

    uint256 public reserveETH;
    uint256 public reserveUSDC;
    uint256 public escrowedETH;
    uint256 public escrowedUSDC;
    uint256 public claimableETH;
    uint256 public claimableUSDC;
    uint256 public currentBatchId;
    bool private entered;

    Order[] public orders;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => uint256[]) private batchOrderIds;
    mapping(uint256 => uint256) public partialOrderCount;

    event OrderSubmitted(
        uint256 indexed orderId, uint256 indexed batchId, address indexed trader,
        bool isBuyETH, uint256 amountIn, uint256 minOut
    );
    event PartialOrderSubmitted(uint256 indexed orderId, uint256 minFillIn);
    event BatchSettled(
        uint256 indexed batchId, uint256 clearingPrice, uint256 totalBuyUSDC,
        uint256 totalSellETH, uint256 cowUSDC, int256 poolDeltaETH,
        int256 poolDeltaUSDC, uint256 refundedCount
    );
    event BatchPartialFill(
        uint256 indexed batchId, uint256 indexed orderId,
        uint256 filledIn, uint256 receivedOut, uint256 refundedIn
    );
    event OrderClaimed(uint256 indexed orderId, address indexed trader, uint256 receivedOut, uint256 refundedIn);

    error InvalidConfiguration();
    error UnauthorizedInitializer();
    error AlreadyInitialized();
    error NotInitialized();
    error ZeroAmount();
    error AmountTooLarge();
    error InvalidMinimumFill();
    error TransferFailed();
    error ReentrantCall();
    error BatchWindowClosed(uint256 batchId, uint256 endTime);
    error BatchWindowNotClosed(uint256 batchId, uint256 endTime);
    error BatchFull(uint256 batchId);
    error PartialOrderCapacityReached(uint256 batchId);
    error NotOrderOwner(uint256 orderId);
    error OrderNotSettled(uint256 orderId);
    error AlreadyClaimed(uint256 orderId);

    constructor(address ethToken, address usdcToken, uint256 duration, BatchAuctionDEX baselineSolver) {
        if (
            ethToken == usdcToken || ethToken.code.length == 0 || usdcToken.code.length == 0
                || address(baselineSolver).code.length == 0 || duration == 0 || duration > type(uint32).max
        ) revert InvalidConfiguration();
        eth = IBalanceToken(ethToken);
        usdc = IBalanceToken(usdcToken);
        solver = baselineSolver;
        initializer = msg.sender;
        batchDuration = duration;
    }

    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    function initPool(uint256 ethAmount, uint256 usdcAmount) external nonReentrant {
        if (msg.sender != initializer) revert UnauthorizedInitializer();
        if (reserveETH != 0) revert AlreadyInitialized();
        if (ethAmount == 0 || usdcAmount == 0) revert ZeroAmount();
        if (ethAmount > MAX_TRACKED_ASSETS || usdcAmount > MAX_TRACKED_ASSETS) revert AmountTooLarge();
        _deposit(eth, ethAmount);
        _deposit(usdc, usdcAmount);
        reserveETH = ethAmount;
        reserveUSDC = usdcAmount;
        _openBatch(0);
    }

    function submitOrder(bool isBuyETH, uint256 amountIn, uint256 minOut) external nonReentrant returns (uint256) {
        return _submit(isBuyETH, amountIn, minOut, 0);
    }

    /// @param minOut Minimum output at full size; a reduced fill must meet this exchange rate.
    /// @param minFillIn The smallest authorized input amount and this version's single trial size.
    function submitPartialOrder(bool isBuyETH, uint256 amountIn, uint256 minOut, uint256 minFillIn)
        external nonReentrant returns (uint256)
    {
        if (minFillIn == 0 || minFillIn >= amountIn) revert InvalidMinimumFill();
        return _submit(isBuyETH, amountIn, minOut, minFillIn);
    }

    function _submit(bool isBuyETH, uint256 amountIn, uint256 minOut, uint256 minFillIn)
        private returns (uint256 orderId)
    {
        if (reserveETH == 0) revert NotInitialized();
        if (amountIn == 0) revert ZeroAmount();
        uint256 bid = currentBatchId;
        uint256 end = batches[bid].endTime;
        if (block.timestamp >= end) revert BatchWindowClosed(bid, end);
        if (batchOrderIds[bid].length >= MAX_ORDERS_PER_BATCH) revert BatchFull(bid);
        uint256 tracked = isBuyETH ? reserveUSDC + escrowedUSDC + claimableUSDC
                                  : reserveETH + escrowedETH + claimableETH;
        if (amountIn > MAX_TRACKED_ASSETS - tracked || minOut > MAX_TRACKED_ASSETS) revert AmountTooLarge();
        if (minFillIn != 0) {
            if (partialOrderCount[bid] == MAX_PARTIAL_ORDERS_PER_BATCH) revert PartialOrderCapacityReached(bid);
            partialOrderCount[bid]++;
        }
        _deposit(isBuyETH ? usdc : eth, amountIn);
        if (isBuyETH) escrowedUSDC += amountIn;
        else escrowedETH += amountIn;
        orderId = orders.length;
        orders.push(Order(msg.sender, uint64(bid), isBuyETH, Status.Pending, amountIn, minOut, minFillIn, 0, 0, 0));
        batchOrderIds[bid].push(orderId);
        emit OrderSubmitted(orderId, bid, msg.sender, isBuyETH, amountIn, minOut);
        if (minFillIn != 0) emit PartialOrderSubmitted(orderId, minFillIn);
    }

    function settleBatch() external nonReentrant {
        if (reserveETH == 0) revert NotInitialized();
        uint256 bid = currentBatchId;
        uint256[] storage ids = batchOrderIds[bid];
        if (block.timestamp < batches[bid].endTime) revert BatchWindowNotClosed(bid, batches[bid].endTime);
        Order[] memory book = new Order[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) book[i] = orders[ids[i]];
        Clearing memory baseline = _clear(book, book.length);
        Clearing memory result = _review(book, _clearingBeforeTrims(ids, book, baseline));
        _finalize(bid, ids, result);
        currentBatchId = bid + 1;
        _openBatch(bid + 1);
    }

    /// @dev Variant B uses the original full-order settlement before reviewing opt-ins.
    function _clearingBeforeTrims(uint256[] storage, Order[] memory, Clearing memory baseline)
        internal virtual returns (Clearing memory)
    {
        return baseline;
    }

    /// @dev A missing trim index evaluates the original full-order pruning rule.
    function _clear(Order[] memory book, uint256 trimIndex) private view returns (Clearing memory result) {
        uint256 count = book.length;
        result.fills = new uint256[](count);
        result.payouts = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            result.fills[i] = i == trimIndex ? book[i].minFillIn : book[i].amountIn;
        }
        for (uint256 round = 0; round <= count; round++) {
            uint256 buyTotal;
            uint256 sellTotal;
            for (uint256 i = 0; i < count; i++) {
                if (book[i].isBuyETH) buyTotal += result.fills[i];
                else sellTotal += result.fills[i];
            }
            // The canonical solver divides by the truncated net-sell price.
            // At extremely small price ratios, no trade is representable at its precision.
            if (_unrepresentableNetSell(buyTotal, sellTotal)) return _refundClearing(count);
            result.solution = solver._solve(reserveETH, reserveUSDC, buyTotal, sellTotal);
            if (result.solution.price == 0 && (buyTotal != 0 || sellTotal != 0)) {
                return _refundClearing(count);
            }
            bool removed;
            for (uint256 i = 0; i < count; i++) {
                uint256 fill = result.fills[i];
                if (fill == 0) continue;
                uint256 payout = book[i].isBuyETH
                    ? fill * result.solution.ethToBuyers / buyTotal
                    : fill * result.solution.usdcToSellers / sellTotal;
                if ((i == trimIndex && payout == 0) || payout * book[i].amountIn < book[i].minOut * fill) {
                    result.fills[i] = 0;
                    result.payouts[i] = 0;
                    removed = true;
                } else {
                    result.payouts[i] = payout;
                }
            }
            if (!removed) break;
        }
    }

    function _unrepresentableNetSell(uint256 buyTotal, uint256 sellTotal) internal view returns (bool) {
        return buyTotal * reserveETH * 1000 < sellTotal * reserveUSDC * 997
            && (reserveUSDC + buyTotal) * 997 * 1e18 < reserveETH * 1000 + sellTotal * 997;
    }

    function _refundClearing(uint256 count) private view returns (Clearing memory result) {
        result.solution = solver._solve(reserveETH, reserveUSDC, 0, 0);
        result.fills = new uint256[](count);
        result.payouts = new uint256[](count);
    }

    function _review(Order[] memory book, Clearing memory baseline) private view returns (Clearing memory best) {
        best = baseline;
        bytes32 bestKey;
        for (uint256 i = 0; i < book.length; i++) {
            Order memory candidate = book[i];
            if (candidate.minFillIn == 0 || baseline.fills[i] != 0) continue;
            Clearing memory trial = _clear(book, i);
            if (trial.fills[i] == 0 || trial.solution.cowUSDC <= baseline.solution.cowUSDC) continue;
            bytes32 key = keccak256(abi.encode(
                candidate.trader, candidate.isBuyETH, candidate.amountIn, candidate.minOut, candidate.minFillIn
            ));
            if (
                trial.solution.cowUSDC < best.solution.cowUSDC
                    || (trial.solution.cowUSDC == best.solution.cowUSDC && key >= bestKey)
            ) continue;
            if (!_preservesBaseline(baseline, trial)) continue;
            best = trial;
            bestKey = key;
        }
    }

    function _preservesBaseline(Clearing memory baseline, Clearing memory trial) private pure returns (bool) {
        for (uint256 i = 0; i < baseline.fills.length; i++) {
            if (baseline.fills[i] == 0) continue;
            if (trial.fills[i] != baseline.fills[i] || trial.payouts[i] < baseline.payouts[i]) return false;
        }
        return true;
    }

    function _finalize(uint256 bid, uint256[] storage ids, Clearing memory result) private {
        Batch storage b = batches[bid];
        for (uint256 i = 0; i < ids.length; i++) {
            Order storage order = orders[ids[i]];
            uint256 fill = result.fills[i];
            uint256 payout = result.payouts[i];
            uint256 refund = order.amountIn - fill;
            order.filledIn = fill;
            order.receivedOut = payout;
            order.refundedIn = refund;
            if (fill == 0) {
                order.status = Status.Refunded;
                b.refundedCount++;
            } else if (refund != 0) {
                order.status = Status.PartialFilled;
                emit BatchPartialFill(bid, ids[i], fill, payout, refund);
            } else {
                order.status = Status.Settled;
            }
            if (order.isBuyETH) {
                escrowedUSDC -= order.amountIn;
                claimableUSDC += refund;
                claimableETH += payout;
            } else {
                escrowedETH -= order.amountIn;
                claimableETH += refund;
                claimableUSDC += payout;
            }
        }

        BatchAuctionDEX.Solution memory s = result.solution;
        reserveETH = uint256(int256(reserveETH) + s.poolDeltaETH);
        reserveUSDC = uint256(int256(reserveUSDC) + s.poolDeltaUSDC);
        b.settled = true;
        b.totalBuyUSDC = s.B;
        b.totalSellETH = s.S;
        b.ethToBuyers = s.ethToBuyers;
        b.usdcToSellers = s.usdcToSellers;
        b.clearingPrice = s.price;
        b.cowUSDC = s.cowUSDC;
        b.poolDeltaETH = s.poolDeltaETH;
        b.poolDeltaUSDC = s.poolDeltaUSDC;
        b.orderCount = uint32(ids.length);
        emit BatchSettled(bid, s.price, s.B, s.S, s.cowUSDC, s.poolDeltaETH, s.poolDeltaUSDC, b.refundedCount);
    }

    function claim(uint256 orderId) external nonReentrant returns (uint256 receivedOut, uint256 refundedIn) {
        Order storage order = orders[orderId];
        if (order.trader != msg.sender) revert NotOrderOwner(orderId);
        if (order.status == Status.Pending) revert OrderNotSettled(orderId);
        if (order.status == Status.Claimed) revert AlreadyClaimed(orderId);
        receivedOut = order.receivedOut;
        refundedIn = order.refundedIn;
        order.status = Status.Claimed;
        if (order.isBuyETH) {
            claimableETH -= receivedOut;
            claimableUSDC -= refundedIn;
        } else {
            claimableUSDC -= receivedOut;
            claimableETH -= refundedIn;
        }
        _pay(order.isBuyETH ? eth : usdc, receivedOut);
        _pay(order.isBuyETH ? usdc : eth, refundedIn);
        emit OrderClaimed(orderId, msg.sender, receivedOut, refundedIn);
    }

    function _openBatch(uint256 bid) private {
        batches[bid].startTime = uint64(block.timestamp);
        batches[bid].endTime = uint64(block.timestamp + batchDuration);
    }

    function _deposit(IBalanceToken token, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert TransferFailed();
    }

    function _pay(IBalanceToken token, uint256 amount) private {
        if (amount != 0 && !token.transfer(msg.sender, amount)) revert TransferFailed();
    }

    function getBatchOrderIds(uint256 batchId) external view returns (uint256[] memory) {
        return batchOrderIds[batchId];
    }

    function ordersLength() external view returns (uint256) {
        return orders.length;
    }
}
