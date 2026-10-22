// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title CctpMessage
/// @notice Calldata accessors for CCTP V2 messages carrying a BurnMessageV2 body.
/// @dev Layout from circlefin/evm-cctp-contracts (src/messages/v2):
///
///   MessageV2                       BurnMessageV2 (body, starts at 148)
///   version                    0    version            0
///   sourceDomain               4    burnToken          4
///   destinationDomain          8    mintRecipient     36
///   nonce                     12    amount            68
///   sender                    44    messageSender    100
///   recipient                 76    maxFee           132
///   destinationCaller        108    feeExecuted      164
///   minFinalityThreshold     140    expirationBlock  196
///   finalityThresholdExecuted 144   hookData         228
library CctpMessage {
    uint256 internal constant BODY_INDEX = 148;
    uint256 internal constant HOOK_DATA_INDEX = 228;
    uint256 internal constant MIN_LENGTH = BODY_INDEX + HOOK_DATA_INDEX;

    error CctpMessage__TooShort(uint256 length);

    function validateLength(bytes calldata message) internal pure {
        if (message.length < MIN_LENGTH) revert CctpMessage__TooShort(message.length);
    }

    function sourceDomain(bytes calldata message) internal pure returns (uint32) {
        return uint32(bytes4(message[4:8]));
    }

    function destinationDomain(bytes calldata message) internal pure returns (uint32) {
        return uint32(bytes4(message[8:12]));
    }

    function nonce(bytes calldata message) internal pure returns (bytes32) {
        return bytes32(message[12:44]);
    }

    function sender(bytes calldata message) internal pure returns (bytes32) {
        return bytes32(message[44:76]);
    }

    function recipient(bytes calldata message) internal pure returns (bytes32) {
        return bytes32(message[76:108]);
    }

    function destinationCaller(bytes calldata message) internal pure returns (bytes32) {
        return bytes32(message[108:140]);
    }

    function body(bytes calldata message) internal pure returns (bytes calldata) {
        return message[BODY_INDEX:];
    }

    function mintRecipient(bytes calldata burnBody) internal pure returns (bytes32) {
        return bytes32(burnBody[36:68]);
    }

    function amount(bytes calldata burnBody) internal pure returns (uint256) {
        return uint256(bytes32(burnBody[68:100]));
    }

    function messageSender(bytes calldata burnBody) internal pure returns (bytes32) {
        return bytes32(burnBody[100:132]);
    }

    function feeExecuted(bytes calldata burnBody) internal pure returns (uint256) {
        return uint256(bytes32(burnBody[164:196]));
    }

    function hookData(bytes calldata burnBody) internal pure returns (bytes calldata) {
        return burnBody[HOOK_DATA_INDEX:];
    }

    function toBytes32(address account) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }
}
