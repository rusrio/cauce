// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICauceVault} from "./interfaces/ICauceVault.sol";
import {IMessageTransmitterV2} from "./interfaces/IMessageTransmitterV2.sol";
import {CctpMessage} from "./libraries/CctpMessage.sol";

/// @title CauceRelay
/// @notice Receives CCTP V2 burn messages addressed to the CauceVault and settles them.
/// @dev A message is only accepted if it is a genuine USDC burn (handled by the local
///      TokenMessengerV2), minted to the vault, and reserved for this relay as destination
///      caller. The vault's USDC balance must grow by exactly `amount - feeExecuted`.
contract CauceRelay {
    using CctpMessage for bytes;

    // --- State Variables ---
    IMessageTransmitterV2 public immutable MESSAGE_TRANSMITTER;
    address public immutable TOKEN_MESSENGER;
    ICauceVault public immutable CAUCE_VAULT;
    IERC20 public immutable USDC;
    uint32 public immutable LOCAL_DOMAIN;

    // --- Events ---
    event PaymentRelayed(bytes32 indexed messageHash, uint32 indexed sourceDomain, bytes32 nonce, uint256 amount);

    // --- Errors ---
    error CauceRelay__ZeroAddress();
    error CauceRelay__WrongDestinationDomain(uint32 domain);
    error CauceRelay__WrongRecipient(bytes32 recipient);
    error CauceRelay__WrongDestinationCaller(bytes32 destinationCaller);
    error CauceRelay__WrongMintRecipient(bytes32 mintRecipient);
    error CauceRelay__FeeExceedsAmount();
    error CauceRelay__ReceiveMessageFailed();
    error CauceRelay__UnexpectedMintAmount(uint256 expected, uint256 actual);

    // --- Constructor ---
    constructor(address _messageTransmitter, address _tokenMessenger, address _cauceVault) {
        if (_messageTransmitter == address(0) || _tokenMessenger == address(0) || _cauceVault == address(0)) {
            revert CauceRelay__ZeroAddress();
        }
        MESSAGE_TRANSMITTER = IMessageTransmitterV2(_messageTransmitter);
        TOKEN_MESSENGER = _tokenMessenger;
        CAUCE_VAULT = ICauceVault(_cauceVault);
        USDC = ICauceVault(_cauceVault).USDC();
        LOCAL_DOMAIN = IMessageTransmitterV2(_messageTransmitter).localDomain();
    }

    /// @notice Receives an attested CCTP message and settles the payment in the vault.
    /// @dev Permissionless: anyone holding the message and attestation may relay it.
    function relayPayment(bytes calldata message, bytes calldata attestation) external returns (bool) {
        message.validateLength();

        uint32 destinationDomain = message.destinationDomain();
        if (destinationDomain != LOCAL_DOMAIN) revert CauceRelay__WrongDestinationDomain(destinationDomain);

        // Only burn messages handled by the local TokenMessenger mint real USDC. Anyone can send
        // a generic CCTP message with a forged BurnMessage-shaped body to another recipient.
        bytes32 recipient = message.recipient();
        if (recipient != CctpMessage.toBytes32(TOKEN_MESSENGER)) revert CauceRelay__WrongRecipient(recipient);

        bytes32 destinationCaller = message.destinationCaller();
        if (destinationCaller != CctpMessage.toBytes32(address(this))) {
            revert CauceRelay__WrongDestinationCaller(destinationCaller);
        }

        bytes calldata body = message.body();
        bytes32 mintRecipient = body.mintRecipient();
        if (mintRecipient != CctpMessage.toBytes32(address(CAUCE_VAULT))) {
            revert CauceRelay__WrongMintRecipient(mintRecipient);
        }

        uint256 amount = body.amount();
        uint256 fee = body.feeExecuted();
        if (fee > amount) revert CauceRelay__FeeExceedsAmount();
        uint256 expectedMint = amount - fee;

        uint256 balanceBefore = USDC.balanceOf(address(CAUCE_VAULT));
        if (!MESSAGE_TRANSMITTER.receiveMessage(message, attestation)) revert CauceRelay__ReceiveMessageFailed();
        uint256 minted = USDC.balanceOf(address(CAUCE_VAULT)) - balanceBefore;
        if (minted != expectedMint) revert CauceRelay__UnexpectedMintAmount(expectedMint, minted);

        bytes32 messageHash = keccak256(message);
        uint32 sourceDomain = message.sourceDomain();
        // EVM source chains only: messageSender is the burner's address left-padded to 32 bytes.
        address payer = address(uint160(uint256(body.messageSender())));
        CAUCE_VAULT.settle(sourceDomain, messageHash, payer, minted, body.hookData());

        emit PaymentRelayed(messageHash, sourceDomain, message.nonce(), minted);
        return true;
    }
}
