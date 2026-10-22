// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The CauceVault surface used by CauceRelay.
interface ICauceVault {
    function USDC() external view returns (IERC20);

    function settle(uint32 sourceDomain, bytes32 messageHash, address payer, uint256 amount, bytes calldata hookData)
        external;
}
