// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Subset of Circle's CCTP V2 MessageTransmitterV2 used by Cauce.
interface IMessageTransmitterV2 {
    function localDomain() external view returns (uint32);

    function usedNonces(bytes32 nonce) external view returns (uint256);

    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool success);
}
