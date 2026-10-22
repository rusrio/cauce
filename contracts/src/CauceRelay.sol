// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMessageTransmitter {
    function receiveMessage(bytes calldata message, bytes calldata attestation) 
        external 
        returns (bool success);
}

interface ICauceVault {
    function handleReceiveFinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        bytes calldata messageBody
    ) external returns (bool);
}

contract CauceRelay {
    // --- State Variables ---
    IMessageTransmitter public immutable MESSAGE_TRANSMITTER;
    ICauceVault public immutable CAUCE_VAULT;

    // --- Events ---
    event PaymentRelayed(
        bytes32 indexed messageHash,
        address indexed merchant,
        uint256 amount,
        uint32 sourceDomain
    );

    // --- Errors ---
    error CauceRelay__ReceiveMessageFailed();
    error CauceRelay__HookCallFailed();
    error CauceRelay__InvalidMessageLength();

    // --- Constructor ---
    constructor(address _messageTransmitter, address _cauceVault) {
        MESSAGE_TRANSMITTER = IMessageTransmitter(_messageTransmitter);
        CAUCE_VAULT = ICauceVault(_cauceVault);
    }


    function relayPayment(
        bytes calldata message,
        bytes calldata attestation
    ) external returns (bool success) {

        bool receiveSuccess = MESSAGE_TRANSMITTER.receiveMessage(message, attestation);
        if (!receiveSuccess) {
            revert CauceRelay__ReceiveMessageFailed();
        }

        (
            uint32 sourceDomain,
            bytes32 sender,
            /*uint32 finalityThresholdExecuted*/,
            bytes memory messageBody
        ) = _parseCCTPMessage(message);

        bool hookSuccess = CAUCE_VAULT.handleReceiveFinalizedMessage(
            sourceDomain,
            sender,
            messageBody
        );

        if (!hookSuccess) {
            revert CauceRelay__HookCallFailed();
        }

        bytes32 messageHash = keccak256(message);
        
        uint256 amount = _extractAmountFromBurnMessage(messageBody);
        address merchant = _extractMerchantFromHookData(messageBody);
        
        emit PaymentRelayed(messageHash, merchant, amount, sourceDomain);

        return true;
    }

    /**
     * @notice Parses CCTP V2 message format to extract key parameters
     * @dev CCTP V2 Message Structure (148+ bytes):
     *      - 0-4:   version (4 bytes)
     *      - 4-8:   sourceDomain (4 bytes)
     *      - 8-12:  destinationDomain (4 bytes)
     *      - 12-44: nonce (32 bytes)
     *      - 44-76: sender (32 bytes)
     *      - 76-108: recipient (32 bytes)
     *      - 108-140: destinationCaller (32 bytes)
     *      - 140-144: minFinalityThreshold (4 bytes)
     *      - 144-148: finalityThresholdExecuted (4 bytes)
     *      - 148+:  messageBody (variable length - BurnMessage)
     * @param message The full CCTP message
     * @return sourceDomain The source blockchain domain ID
     * @return sender The address that initiated the burn (as bytes32)
     * @return finalityThresholdExecuted The finality threshold used
     * @return messageBody The BurnMessage payload
     */
    function _parseCCTPMessage(bytes calldata message)
        internal
        pure
        returns (
            uint32 sourceDomain,
            bytes32 sender,
            uint32 finalityThresholdExecuted,
            bytes memory messageBody
        )
    {
        // Validate minimum message length (148 bytes header + some messageBody)
        if (message.length < 148) {
            revert CauceRelay__InvalidMessageLength();
        }

        // Extract sourceDomain (offset 4, 4 bytes)
        sourceDomain = uint32(bytes4(message[4:8]));

        // Extract sender (offset 44, 32 bytes)
        sender = bytes32(message[44:76]);

        // Extract finalityThresholdExecuted (offset 144, 4 bytes)
        finalityThresholdExecuted = uint32(bytes4(message[144:148]));

        // Extract messageBody (offset 148 to end)
        messageBody = message[148:];
    }

    function _extractAmountFromBurnMessage(bytes memory messageBody) 
        internal 
        pure 
        returns (uint256 amount) 
    {
        if (messageBody.length < 100) {
            return 0; // Return 0 if message is too short
        }
        
        // Amount is at offset 68 in BurnMessage
        assembly {
            amount := mload(add(add(messageBody, 0x20), 68))
        }
    }

    function _extractMerchantFromHookData(bytes memory messageBody) 
        internal 
        pure 
        returns (address merchant) 
    {
        if (messageBody.length <= 228) {
            return address(0); // Return zero address if no hookData
        }

        // Extract hookData (everything after offset 228)
        bytes memory hookData = new bytes(messageBody.length - 228);
        for (uint256 i = 0; i < hookData.length; i++) {
            hookData[i] = messageBody[228 + i];
        }

        // Decode hookData: abi.encode(address merchant, string orderId)
        // First 32 bytes contain the address (padded)
        if (hookData.length >= 32) {
            (merchant,) = abi.decode(hookData, (address, string));
        }
    }

    function getConfiguration() 
        external 
        view 
        returns (address messageTransmitter, address cauceVault) 
    {
        return (address(MESSAGE_TRANSMITTER), address(CAUCE_VAULT));
    }
}
