// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Min {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title TraditionalAMM - 对照组：Uniswap V2 式恒定乘积池（x * y = k，手续费 0.3%）
/// @notice 每笔交易到达即按当前储备立刻成交，因此"谁排在前面"决定了价格 —— 这正是三明治攻击的根源。
contract TraditionalAMM {
    IERC20Min public immutable eth;   // MockETH
    IERC20Min public immutable usdc;  // MockUSDC
    address public immutable owner;

    uint256 public reserveETH;
    uint256 public reserveUSDC;

    uint256 private constant FEE_NUM = 997;  // 扣 0.3% 手续费后剩 99.7%
    uint256 private constant FEE_DEN = 1000;

    event Swapped(address indexed trader, bool isBuyETH, uint256 amountIn, uint256 amountOut,
                  uint256 reserveETH, uint256 reserveUSDC);

    error AlreadyInitialized();
    error SlippageExceeded(uint256 amountOut, uint256 minOut);
    error ZeroAmount();

    constructor(address _eth, address _usdc) {
        eth = IERC20Min(_eth);
        usdc = IERC20Min(_usdc);
        owner = msg.sender;
    }

    /// @notice 一次性注入初始流动性（演示：100 ETH / 200,000 USDC）
    function initPool(uint256 ethAmount, uint256 usdcAmount) external {
        if (reserveETH != 0 || reserveUSDC != 0) revert AlreadyInitialized();
        eth.transferFrom(msg.sender, address(this), ethAmount);
        usdc.transferFrom(msg.sender, address(this), usdcAmount);
        reserveETH = ethAmount;
        reserveUSDC = usdcAmount;
    }

    /// @notice 恒定乘积报价：out = in*997*R_out / (R_in*1000 + in*997)
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public pure returns (uint256)
    {
        uint256 inWithFee = amountIn * FEE_NUM;
        return (inWithFee * reserveOut) / (reserveIn * FEE_DEN + inWithFee);
    }

    /// @notice 用 USDC 买 ETH
    function swapUSDCForETH(uint256 usdcIn, uint256 minEthOut) external returns (uint256 ethOut) {
        if (usdcIn == 0) revert ZeroAmount();
        ethOut = getAmountOut(usdcIn, reserveUSDC, reserveETH);
        if (ethOut < minEthOut) revert SlippageExceeded(ethOut, minEthOut);
        usdc.transferFrom(msg.sender, address(this), usdcIn);
        reserveUSDC += usdcIn;
        reserveETH -= ethOut;
        eth.transfer(msg.sender, ethOut);
        emit Swapped(msg.sender, true, usdcIn, ethOut, reserveETH, reserveUSDC);
    }

    /// @notice 卖 ETH 换 USDC
    function swapETHForUSDC(uint256 ethIn, uint256 minUsdcOut) external returns (uint256 usdcOut) {
        if (ethIn == 0) revert ZeroAmount();
        usdcOut = getAmountOut(ethIn, reserveETH, reserveUSDC);
        if (usdcOut < minUsdcOut) revert SlippageExceeded(usdcOut, minUsdcOut);
        eth.transferFrom(msg.sender, address(this), ethIn);
        reserveETH += ethIn;
        reserveUSDC -= usdcOut;
        usdc.transfer(msg.sender, usdcOut);
        emit Swapped(msg.sender, false, ethIn, usdcOut, reserveETH, reserveUSDC);
    }
}
