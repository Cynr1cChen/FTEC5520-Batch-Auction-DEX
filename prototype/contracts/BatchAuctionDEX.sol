// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Lite {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title BatchAuctionDEX - 实验组：批处理拍卖 + 需求直配(CoW) + 统一清算价(UCP)
/// @notice 一个时间窗口内的订单先"收集不成交"，窗口结束后：
///         ① 买卖双方先在批内互相对冲（CoW，不经过池子、不付池子手续费）；
///         ② 只把对冲剩下的"净差额"一次性丢给内置的 x*y=k 池；
///         ③ 本批所有同方向订单按【同一个价格】按比例分配成交结果。
///         因为批内谁先谁后拿到的价格完全一样，抢跑 / 三明治在同一批内无利可图。
contract BatchAuctionDEX {
    // ---------------------------------------------------------------- 类型
    enum Status { Pending, Settled, Refunded, Claimed }

    struct Order {
        address trader;
        uint64  batchId;
        bool    isBuyETH;   // true = 用 USDC 买 ETH；false = 卖 ETH 换 USDC
        bool    refunded;   // 结算时因限价不满足被退回
        Status  status;
        uint256 amountIn;   // 买单：投入 USDC；卖单：投入 ETH
        uint256 minOut;     // 用户可接受的最少到手数量（限价保护）
        uint256 payout;     // 结算后应领取的数量（成交所得或原路退款）
    }

    struct Batch {
        uint64  startTime;
        uint64  endTime;
        bool    settled;
        uint256 totalBuyUSDC;    // B：本批成交买单投入的 USDC 总额
        uint256 totalSellETH;    // S：本批成交卖单投入的 ETH 总额
        uint256 ethToBuyers;     // 分给全部买单的 ETH 总量
        uint256 usdcToSellers;   // 分给全部卖单的 USDC 总量
        uint256 clearingPrice;   // 统一清算价（USDC/ETH，1e18 定点）
        uint256 cowUSDC;         // 批内直配（未经池子）的成交额，以 USDC 计
        int256  poolDeltaETH;    // 池子 ETH 储备变化（负数 = 池子付出 ETH）
        int256  poolDeltaUSDC;   // 池子 USDC 储备变化
        uint32  orderCount;
        uint32  refundedCount;
    }

    // ---------------------------------------------------------------- 状态
    IERC20Lite public immutable eth;
    IERC20Lite public immutable usdc;
    uint256 public immutable batchDuration;   // 批次窗口长度（秒），演示用 30
    uint256 public constant MAX_ORDERS_PER_BATCH = 50;

    uint256 public reserveETH;
    uint256 public reserveUSDC;
    uint256 public currentBatchId;

    Order[] public orders;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => uint256[]) internal batchOrderIds;

    uint256 private constant FEE_NUM = 997;
    uint256 private constant FEE_DEN = 1000;
    uint256 private constant ONE = 1e18;

    // ---------------------------------------------------------------- 事件
    event OrderSubmitted(uint256 indexed orderId, uint256 indexed batchId, address indexed trader,
                         bool isBuyETH, uint256 amountIn, uint256 minOut);
    event BatchSettled(uint256 indexed batchId, uint256 clearingPrice, uint256 totalBuyUSDC,
                       uint256 totalSellETH, uint256 cowUSDC, int256 poolDeltaETH,
                       int256 poolDeltaUSDC, uint256 refundedCount);
    event OrderClaimed(uint256 indexed orderId, address indexed trader, bool refunded, uint256 amount);

    // ---------------------------------------------------------------- 错误（演示中的"非法操作拦截"）
    error AlreadyInitialized();
    error ZeroAmount();
    error BatchWindowClosed(uint256 batchId, uint256 endTime);     // 窗口已关仍想挤进来
    error BatchWindowNotClosed(uint256 batchId, uint256 endTime);  // 窗口未到期就想结算
    error BatchFull(uint256 batchId);
    error NotOrderOwner(uint256 orderId);
    error OrderNotSettled(uint256 orderId);
    error AlreadyClaimed(uint256 orderId);

    constructor(address _eth, address _usdc, uint256 _batchDuration) {
        eth = IERC20Lite(_eth);
        usdc = IERC20Lite(_usdc);
        batchDuration = _batchDuration;
        batches[0].startTime = uint64(block.timestamp);
        batches[0].endTime = uint64(block.timestamp + _batchDuration);
    }

    function initPool(uint256 ethAmount, uint256 usdcAmount) external {
        if (reserveETH != 0 || reserveUSDC != 0) revert AlreadyInitialized();
        eth.transferFrom(msg.sender, address(this), ethAmount);
        usdc.transferFrom(msg.sender, address(this), usdcAmount);
        reserveETH = ethAmount;
        reserveUSDC = usdcAmount;
    }

    // ================================================================ 1. 下单（资产先托管进合约）
    function submitOrder(bool isBuyETH, uint256 amountIn, uint256 minOut) external returns (uint256 orderId) {
        if (amountIn == 0) revert ZeroAmount();
        uint256 bid = currentBatchId;
        Batch storage b = batches[bid];
        if (block.timestamp >= b.endTime) revert BatchWindowClosed(bid, b.endTime);
        if (batchOrderIds[bid].length >= MAX_ORDERS_PER_BATCH) revert BatchFull(bid);

        (isBuyETH ? usdc : eth).transferFrom(msg.sender, address(this), amountIn);

        orderId = orders.length;
        orders.push(Order({
            trader: msg.sender, batchId: uint64(bid), isBuyETH: isBuyETH, refunded: false,
            status: Status.Pending, amountIn: amountIn, minOut: minOut, payout: 0
        }));
        batchOrderIds[bid].push(orderId);
        emit OrderSubmitted(orderId, bid, msg.sender, isBuyETH, amountIn, minOut);
    }

    // ================================================================ 2. 结算（任何人可在窗口到期后调用）
    function settleBatch() external {
        uint256 bid = currentBatchId;
        Batch storage b = batches[bid];
        if (block.timestamp < b.endTime) revert BatchWindowNotClosed(bid, b.endTime);

        uint256[] storage ids = batchOrderIds[bid];
        uint256 n = ids.length;
        bool[] memory excluded = new bool[](n);
        Solution memory s;

        // 迭代：若某笔订单在当前统一价下达不到其 minOut，就把它剔除（之后原路退款）并重算，
        // 而不是 revert 整批 —— 防止一笔"恶意苛刻限价单"卡死所有人（DoS）。
        for (uint256 round = 0; round <= n; round++) {
            (uint256 B, uint256 S) = _totals(ids, excluded);
            s = _solve(reserveETH, reserveUSDC, B, S);
            bool changed = false;
            for (uint256 i = 0; i < n; i++) {
                if (excluded[i]) continue;
                Order storage o = orders[ids[i]];
                uint256 out = o.isBuyETH ? (o.amountIn * s.ethToBuyers) / B
                                         : (o.amountIn * s.usdcToSellers) / S;
                if (out < o.minOut) { excluded[i] = true; changed = true; }
            }
            if (!changed) break;
        }

        s = _reviewExcluded(ids, excluded, s);

        // 落账：成交单记录应得数量，被剔除单记录退款数量
        uint32 refundedCount = 0;
        for (uint256 i = 0; i < n; i++) {
            Order storage o = orders[ids[i]];
            if (excluded[i]) {
                o.status = Status.Refunded;
                o.refunded = true;
                o.payout = o.amountIn;
                refundedCount++;
            } else {
                o.status = Status.Settled;
                o.payout = o.isBuyETH ? (o.amountIn * s.ethToBuyers) / s.B
                                      : (o.amountIn * s.usdcToSellers) / s.S;
            }
        }

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
        b.orderCount = uint32(n);
        b.refundedCount = refundedCount;
        emit BatchSettled(bid, s.price, s.B, s.S, s.cowUSDC, s.poolDeltaETH, s.poolDeltaUSDC, refundedCount);

        // 开启下一批
        currentBatchId = bid + 1;
        batches[bid + 1].startTime = uint64(block.timestamp);
        batches[bid + 1].endTime = uint64(block.timestamp + batchDuration);
    }

    // ================================================================ 3. 领取（Pull Payment，先改状态再转账）
    function claim(uint256 orderId) external returns (uint256 amount) {
        Order storage o = orders[orderId];
        if (o.trader != msg.sender) revert NotOrderOwner(orderId);
        if (o.status == Status.Claimed) revert AlreadyClaimed(orderId);
        if (o.status == Status.Pending) revert OrderNotSettled(orderId);

        amount = o.payout;
        bool refunded = o.refunded;
        bool payInETH = refunded ? !o.isBuyETH : o.isBuyETH;  // 退款退原币；成交给对手币
        o.status = Status.Claimed;                              // Checks-Effects-Interactions
        (payInETH ? eth : usdc).transfer(msg.sender, amount);
        emit OrderClaimed(orderId, msg.sender, refunded, amount);
    }

    // ================================================================ 核心数学：三段式闭合解
    struct Solution {
        uint256 B; uint256 S;
        uint256 ethToBuyers; uint256 usdcToSellers;
        uint256 price; uint256 cowUSDC;
        int256 poolDeltaETH; int256 poolDeltaUSDC;
    }

    function _reviewExcluded(uint256[] storage, bool[] memory, Solution memory baseline)
        internal virtual returns (Solution memory)
    {
        return baseline;
    }

    function _totals(uint256[] storage ids, bool[] memory excluded)
        internal view returns (uint256 B, uint256 S)
    {
        for (uint256 i = 0; i < ids.length; i++) {
            if (excluded[i]) continue;
            Order storage o = orders[ids[i]];
            if (o.isBuyETH) B += o.amountIn; else S += o.amountIn;
        }
    }

    /// @dev x = 池中 ETH，y = 池中 USDC，B = 买单 USDC 总额，S = 卖单 ETH 总额，r = 0.997
    ///  情形 A（纯 CoW）：y*r/x <= B/S <= y/(x*r)       → p = B/S，池子不动
    ///  情形 B（净买入）：B/S > y/(x*r) 或 S = 0         → p = (y + B*r) / ((x + S)*r)
    ///  情形 C（净卖出）：B/S < y*r/x  或 B = 0         → p = (y + B)*r / (x + S*r)
    function _solve(uint256 x, uint256 y, uint256 B, uint256 S) public pure returns (Solution memory s) {
        s.B = B; s.S = S;
        if (B == 0 && S == 0) { s.price = (y * ONE) / x; return s; }

        bool cowZone = B > 0 && S > 0
            && B * x * FEE_DEN >= S * y * FEE_NUM     // B/S >= y*r/x
            && B * x * FEE_NUM <= S * y * FEE_DEN;    // B/S <= y/(x*r)

        if (cowZone) {
            s.price = (B * ONE) / S;
            s.ethToBuyers = S;
            s.usdcToSellers = B;
            s.cowUSDC = B;
        } else if (S == 0 || B * x * FEE_NUM > S * y * FEE_DEN) {
            // 净买入 ETH：卖方的 ETH 全部被买方内部吃掉，剩余 USDC 进池换 ETH
            s.price = ((y * FEE_DEN + B * FEE_NUM) * ONE) / ((x + S) * FEE_NUM);
            uint256 sellersUSDC = (S * s.price) / ONE;
            uint256 dyIn = B - sellersUSDC;
            uint256 dxOut = (dyIn * FEE_NUM * x) / (y * FEE_DEN + dyIn * FEE_NUM);
            s.ethToBuyers = S + dxOut;
            s.usdcToSellers = sellersUSDC;
            s.cowUSDC = sellersUSDC;
            s.poolDeltaETH = -int256(dxOut);
            s.poolDeltaUSDC = int256(dyIn);
        } else {
            // 净卖出 ETH：买方的 USDC 全部被卖方内部吃掉，剩余 ETH 进池换 USDC
            s.price = ((y + B) * FEE_NUM * ONE) / (x * FEE_DEN + S * FEE_NUM);
            uint256 buyersETH = (B * ONE) / s.price;
            if (buyersETH > S) buyersETH = S;
            uint256 dxIn = S - buyersETH;
            uint256 dyOut = (dxIn * FEE_NUM * y) / (x * FEE_DEN + dxIn * FEE_NUM);
            s.ethToBuyers = buyersETH;
            s.usdcToSellers = B + dyOut;
            s.cowUSDC = B;
            s.poolDeltaETH = int256(dxIn);
            s.poolDeltaUSDC = -int256(dyOut);
        }
    }

    // ================================================================ 视图
    function getBatchOrderIds(uint256 batchId) external view returns (uint256[] memory) {
        return batchOrderIds[batchId];
    }

    function ordersLength() external view returns (uint256) {
        return orders.length;
    }
}
