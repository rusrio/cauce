// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Builds CCTP V2 messages with a BurnMessageV2 body, byte-for-byte as Circle does.
library CctpMessageBuilder {
    struct Message {
        uint32 sourceDomain;
        uint32 destinationDomain;
        bytes32 nonce;
        bytes32 sender;
        bytes32 recipient;
        bytes32 destinationCaller;
        uint32 finalityThresholdExecuted;
        bytes32 burnToken;
        bytes32 mintRecipient;
        uint256 amount;
        bytes32 messageSender;
        uint256 maxFee;
        uint256 feeExecuted;
        bytes hookData;
    }

    function build(Message memory m) internal pure returns (bytes memory) {
        bytes memory body = abi.encodePacked(
            uint32(1), // body version
            m.burnToken,
            m.mintRecipient,
            m.amount,
            m.messageSender,
            m.maxFee,
            m.feeExecuted,
            uint256(0), // expirationBlock
            m.hookData
        );
        return abi.encodePacked(
            uint32(1), // message version
            m.sourceDomain,
            m.destinationDomain,
            m.nonce,
            m.sender,
            m.recipient,
            m.destinationCaller,
            uint32(1000), // minFinalityThreshold
            m.finalityThresholdExecuted,
            body
        );
    }

    function toBytes32(address account) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }
}
