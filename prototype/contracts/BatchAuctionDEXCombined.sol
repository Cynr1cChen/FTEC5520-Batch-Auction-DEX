// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BatchAuctionDEX} from "./BatchAuctionDEX.sol";
import {BatchAuctionDEXPartialFill} from "./BatchAuctionDEXPartialFill.sol";

/// @notice A sequential experiment: whole-order reconsideration, then optional partial fill.
/// @dev The partial-fill stage must preserve every accepted fill and payout from the first stage.
contract BatchAuctionDEXCombined is BatchAuctionDEXPartialFill {
    event OrderReconsidered(
        uint256 indexed batchId,
        uint256 indexed orderId,
        uint256 originalClearingPrice,
        uint256 originalCoWUSDC
    );

    constructor(address ethToken, address usdcToken, uint256 duration, BatchAuctionDEX baselineSolver)
        BatchAuctionDEXPartialFill(ethToken, usdcToken, duration, baselineSolver)
    {}

    function _clearingBeforeTrims(uint256[] storage ids, Order[] memory book, Clearing memory baseline)
        internal override returns (Clearing memory)
    {
        uint256 selected = book.length;
        bytes32 bestKey;
        uint256 bestMinFillIn;
        BatchAuctionDEX.Solution memory best = baseline.solution;
        for (uint256 i = 0; i < book.length; i++) {
            if (baseline.fills[i] != 0) continue;
            Order memory order = book[i];
            uint256 buyTotal = baseline.solution.B + (order.isBuyETH ? order.amountIn : 0);
            uint256 sellTotal = baseline.solution.S + (order.isBuyETH ? 0 : order.amountIn);
            if (_unrepresentableNetSell(buyTotal, sellTotal)) continue;
            BatchAuctionDEX.Solution memory candidate = solver._solve(reserveETH, reserveUSDC, buyTotal, sellTotal);
            if (candidate.price == 0 || candidate.cowUSDC < best.cowUSDC) continue;
            uint256 payout = _payout(candidate, order);
            if (payout == 0 || payout < order.minOut || !_preservesPayouts(book, baseline, candidate)) continue;

            bytes32 key = keccak256(abi.encode(order.trader, order.isBuyETH, order.amountIn, order.minOut));
            // Keep A's ordering for distinct identities. For equal identities, preserve
            // optionality by preferring the order with the lower minimum partial fill.
            bool winsTie = key < bestKey || (key == bestKey && order.minFillIn < bestMinFillIn);
            if (selected == book.length || candidate.cowUSDC > best.cowUSDC || winsTie) {
                selected = i;
                best = candidate;
                bestKey = key;
                bestMinFillIn = order.minFillIn;
            }
        }
        if (selected == book.length) return baseline;

        emit OrderReconsidered(currentBatchId, ids[selected], baseline.solution.price, baseline.solution.cowUSDC);
        baseline.solution = best;
        baseline.fills[selected] = book[selected].amountIn;
        for (uint256 i = 0; i < book.length; i++) {
            if (baseline.fills[i] != 0) baseline.payouts[i] = _payout(best, book[i]);
        }
        return baseline;
    }

    function _preservesPayouts(Order[] memory book, Clearing memory baseline, BatchAuctionDEX.Solution memory candidate)
        private pure returns (bool)
    {
        for (uint256 i = 0; i < book.length; i++) {
            if (baseline.fills[i] != 0 && _payout(candidate, book[i]) < baseline.payouts[i]) return false;
        }
        return true;
    }

    function _payout(BatchAuctionDEX.Solution memory result, Order memory order) private pure returns (uint256) {
        return order.isBuyETH ? order.amountIn * result.ethToBuyers / result.B
                              : order.amountIn * result.usdcToSellers / result.S;
    }
}
