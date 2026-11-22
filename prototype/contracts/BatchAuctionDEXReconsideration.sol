// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BatchAuctionDEX} from "./BatchAuctionDEX.sol";

/// @notice Mechanism A: reconsider at most one excluded whole order before booking.
contract BatchAuctionDEXReconsideration is BatchAuctionDEX {
    struct ReviewOrder {
        bool isBuyETH;
        uint256 amountIn;
        uint256 requiredOut;
    }

    event OrderReconsidered(
        uint256 indexed batchId,
        uint256 indexed orderId,
        uint256 originalClearingPrice,
        uint256 originalCoWUSDC
    );

    constructor(address ethToken, address usdcToken, uint256 duration)
        BatchAuctionDEX(ethToken, usdcToken, duration)
    {}

    function _reviewExcluded(uint256[] storage ids, bool[] memory excluded, Solution memory baseline)
        internal override returns (Solution memory best)
    {
        best = baseline;
        uint256 count = ids.length;
        bool hasExcluded;
        for (uint256 i; i < count; ++i) {
            if (excluded[i]) {
                hasExcluded = true;
                break;
            }
        }
        if (!hasExcluded) return best;

        ReviewOrder[] memory review = new ReviewOrder[](count);
        for (uint256 i; i < count; ++i) {
            Order storage order = orders[ids[i]];
            bool isBuyETH = order.isBuyETH;
            uint256 amountIn = order.amountIn;
            // Incumbents retain at least their baseline payout. A restored order must
            // clear its own limit and receive something even if it set minOut to zero.
            uint256 requiredOut = excluded[i]
                ? (order.minOut == 0 ? 1 : order.minOut)
                : _orderPayout(baseline, isBuyETH, amountIn);
            review[i] = ReviewOrder(isBuyETH, amountIn, requiredOut);
        }

        uint256 selected = count;
        bytes32 bestKey;
        for (uint256 i; i < count; ++i) {
            if (!excluded[i]) continue;
            ReviewOrder memory r = review[i];
            Solution memory candidate = _withCandidate(baseline, r);
            if (candidate.cowUSDC < best.cowUSDC) continue;
            if (_orderPayout(candidate, r.isBuyETH, r.amountIn) < r.requiredOut) continue;
            if (!_preservesIncumbents(review, excluded, candidate)) continue;

            Order storage order = orders[ids[i]];
            // Identical orders from one owner have the same economic result. A tie
            // between those may choose either ID, which is assigned at submission.
            bytes32 key = keccak256(abi.encode(order.trader, r.isBuyETH, r.amountIn, order.minOut));
            if (selected == count || candidate.cowUSDC > best.cowUSDC || key < bestKey) {
                best = candidate;
                bestKey = key;
                selected = i;
            }
        }

        if (selected != count) {
            excluded[selected] = false;
            emit OrderReconsidered(currentBatchId, ids[selected], baseline.price, baseline.cowUSDC);
        }
    }

    function _withCandidate(Solution memory baseline, ReviewOrder memory r) private view returns (Solution memory) {
        return _solve(
            reserveETH,
            reserveUSDC,
            baseline.B + (r.isBuyETH ? r.amountIn : 0),
            baseline.S + (r.isBuyETH ? 0 : r.amountIn)
        );
    }

    function _preservesIncumbents(ReviewOrder[] memory review, bool[] memory excluded, Solution memory candidate)
        private pure returns (bool)
    {
        for (uint256 i; i < review.length; ++i) {
            if (excluded[i]) continue;
            ReviewOrder memory incumbent = review[i];
            if (_orderPayout(candidate, incumbent.isBuyETH, incumbent.amountIn) < incumbent.requiredOut) {
                return false;
            }
        }
        return true;
    }

    function _orderPayout(Solution memory solution, bool isBuyETH, uint256 amountIn)
        private pure returns (uint256)
    {
        return isBuyETH
            ? (amountIn * solution.ethToBuyers) / solution.B
            : (amountIn * solution.usdcToSellers) / solution.S;
    }
}
