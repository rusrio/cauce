// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockUSDC} from "./MockUSDC.sol";

interface IMessageHandlerV2 {
    function handleReceiveFinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external returns (bool);
}

/// @notice Mirrors the checks of Circle's MessageTransmitterV2.receiveMessage, minus signatures.
contract MockMessageTransmitter {
    uint32 public immutable localDomain;
    mapping(bytes32 => uint256) public usedNonces;

    constructor(uint32 _localDomain) {
        localDomain = _localDomain;
    }

    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool) {
        require(attestation.length > 0, "Invalid attestation");
        require(uint32(bytes4(message[8:12])) == localDomain, "Invalid destination domain");
        bytes32 destinationCaller = bytes32(message[108:140]);
        if (destinationCaller != bytes32(0)) {
            require(destinationCaller == bytes32(uint256(uint160(msg.sender))), "Invalid caller for message");
        }
        bytes32 nonce = bytes32(message[12:44]);
        require(usedNonces[nonce] == 0, "Nonce already used");
        usedNonces[nonce] = 1;

        address recipient = address(uint160(uint256(bytes32(message[76:108]))));
        require(
            IMessageHandlerV2(recipient)
                .handleReceiveFinalizedMessage(
                    uint32(bytes4(message[4:8])),
                    bytes32(message[44:76]),
                    uint32(bytes4(message[144:148])),
                    message[148:]
                ),
            "handleReceiveFinalizedMessage() failed"
        );
        return true;
    }
}

/// @notice Mirrors TokenMessengerV2: only trusts registered remote messengers and mints
///         `amount - feeExecuted` to the mint recipient.
contract MockTokenMessenger is IMessageHandlerV2 {
    address public immutable messageTransmitter;
    MockUSDC public immutable usdc;
    mapping(uint32 => bytes32) public remoteTokenMessengers;
    /// @dev Test hook to simulate a minter that does not mint the attested amount.
    uint256 public mintShortfall;

    constructor(address _messageTransmitter, MockUSDC _usdc) {
        messageTransmitter = _messageTransmitter;
        usdc = _usdc;
    }

    function addRemoteTokenMessenger(uint32 domain, bytes32 tokenMessenger) external {
        remoteTokenMessengers[domain] = tokenMessenger;
    }

    function setMintShortfall(uint256 shortfall) external {
        mintShortfall = shortfall;
    }

    function handleReceiveFinalizedMessage(uint32 remoteDomain, bytes32 sender, uint32, bytes calldata body)
        external
        returns (bool)
    {
        require(msg.sender == messageTransmitter, "Invalid message transmitter");
        require(remoteTokenMessengers[remoteDomain] == sender, "Remote TokenMessenger unsupported");
        uint256 amount = uint256(bytes32(body[68:100]));
        uint256 fee = uint256(bytes32(body[164:196]));
        require(fee <= uint256(bytes32(body[132:164])), "Fee exceeds max fee");
        address mintRecipient = address(uint160(uint256(bytes32(body[36:68]))));
        usdc.mint(mintRecipient, amount - fee - mintShortfall);
        return true;
    }
}

/// @notice A generic CCTP message handler an attacker controls: accepts anything, mints nothing.
contract ForgedMessageHandler is IMessageHandlerV2 {
    function handleReceiveFinalizedMessage(uint32, bytes32, uint32, bytes calldata) external pure returns (bool) {
        return true;
    }
}
