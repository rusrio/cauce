// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IMessageHandlerV2
 * @notice Handles messages on the destination domain, forwarded from an IReceiverV2
 * @dev Based on Circle's official CCTP contracts
 * @dev See: https://github.com/circlefin/evm-cctp-contracts/blob/master/src/interfaces/v2/IMessageHandlerV2.sol
 */
interface IMessageHandlerV2 {

    function handleReceiveFinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external returns (bool);

    function handleReceiveUnfinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external returns (bool);
}

