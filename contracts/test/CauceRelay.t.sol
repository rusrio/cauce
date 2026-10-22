// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CauceVault} from "../src/CauceVault.sol";
import {CauceRelay} from "../src/CauceRelay.sol";
import {HookData} from "../src/libraries/HookData.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockMessageTransmitter, MockTokenMessenger, ForgedMessageHandler} from "./mocks/MockCctp.sol";
import {CctpMessageBuilder} from "./utils/CctpMessageBuilder.sol";

contract CauceRelayTest is Test {
    using CctpMessageBuilder for CctpMessageBuilder.Message;

    uint32 internal constant ARC_DOMAIN = 26;
    uint32 internal constant BASE_DOMAIN = 6;
    bytes32 internal constant REMOTE_TOKEN_MESSENGER = bytes32(uint256(0xBA5E));
    bytes internal constant ATTESTATION = hex"01";

    MockUSDC internal usdc;
    MockMessageTransmitter internal transmitter;
    MockTokenMessenger internal tokenMessenger;
    CauceVault internal vault;
    CauceRelay internal relay;

    address internal merchant = makeAddr("merchant");
    address internal payer = makeAddr("payer");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        usdc = new MockUSDC();
        transmitter = new MockMessageTransmitter(ARC_DOMAIN);
        tokenMessenger = new MockTokenMessenger(address(transmitter), usdc);
        tokenMessenger.addRemoteTokenMessenger(BASE_DOMAIN, REMOTE_TOKEN_MESSENGER);

        vault = new CauceVault(address(usdc));
        relay = new CauceRelay(address(transmitter), address(tokenMessenger), address(vault));
        vault.setRelay(address(relay));
    }

    function _payment() internal view returns (CctpMessageBuilder.Message memory) {
        return CctpMessageBuilder.Message({
            sourceDomain: BASE_DOMAIN,
            destinationDomain: ARC_DOMAIN,
            nonce: keccak256("nonce-1"),
            sender: REMOTE_TOKEN_MESSENGER,
            recipient: CctpMessageBuilder.toBytes32(address(tokenMessenger)),
            destinationCaller: CctpMessageBuilder.toBytes32(address(relay)),
            finalityThresholdExecuted: 1000,
            burnToken: bytes32(uint256(0xC0FFEE)),
            mintRecipient: CctpMessageBuilder.toBytes32(address(vault)),
            amount: 1_020_000,
            messageSender: CctpMessageBuilder.toBytes32(payer),
            maxFee: 20_000,
            feeExecuted: 10_000,
            hookData: HookData.encode(HookData.Payload(merchant, "order-1", 0, address(0)))
        });
    }

    function test_RelaysGenuinePayment() public {
        bytes memory message = _payment().build();

        vm.expectEmit(address(relay));
        emit CauceRelay.PaymentRelayed(keccak256(message), BASE_DOMAIN, keccak256("nonce-1"), 1_010_000);
        relay.relayPayment(message, ATTESTATION);

        assertEq(usdc.balanceOf(address(vault)), 1_010_000);
        assertEq(vault.balances(merchant), 1_010_000);
        assertEq(transmitter.usedNonces(keccak256("nonce-1")), 1);
    }

    function test_RefundsPayerWhenHookDataIsInvalid() public {
        CctpMessageBuilder.Message memory m = _payment();
        m.hookData = hex"deadbeef";

        relay.relayPayment(m.build(), ATTESTATION);

        assertEq(vault.balances(payer), 1_010_000);
        assertEq(vault.balances(merchant), 0);
    }

    function test_RevertsOnReplay() public {
        bytes memory message = _payment().build();
        relay.relayPayment(message, ATTESTATION);

        vm.expectRevert("Nonce already used");
        relay.relayPayment(message, ATTESTATION);
    }

    /// Exploit: burn with mintRecipient = attacker and hookData crediting the attacker's merchant.
    function test_RevertsWhenMintRecipientIsNotVault() public {
        CctpMessageBuilder.Message memory m = _payment();
        m.mintRecipient = CctpMessageBuilder.toBytes32(attacker);
        m.hookData = HookData.encode(HookData.Payload(attacker, "steal", 0, address(0)));

        vm.expectRevert(abi.encodeWithSelector(CauceRelay.CauceRelay__WrongMintRecipient.selector, m.mintRecipient));
        relay.relayPayment(m.build(), ATTESTATION);
    }

    /// Exploit: a generic CCTP message (no burn, no mint) whose body imitates a BurnMessage.
    function test_RevertsWhenRecipientIsNotTokenMessenger() public {
        ForgedMessageHandler forged = new ForgedMessageHandler();
        CctpMessageBuilder.Message memory m = _payment();
        m.recipient = CctpMessageBuilder.toBytes32(address(forged));
        m.sender = CctpMessageBuilder.toBytes32(attacker);
        m.hookData = HookData.encode(HookData.Payload(attacker, "forged", 0, address(0)));

        vm.expectRevert(abi.encodeWithSelector(CauceRelay.CauceRelay__WrongRecipient.selector, m.recipient));
        relay.relayPayment(m.build(), ATTESTATION);
    }

    /// Exploit: with destinationCaller = 0 anyone could receive the message directly, minting to
    /// the vault without crediting the merchant. The relay rejects such messages, and the client
    /// always burns with destinationCaller = relay so third parties cannot front-run it.
    function test_RevertsWhenDestinationCallerIsNotRelay() public {
        CctpMessageBuilder.Message memory m = _payment();
        m.destinationCaller = bytes32(0);

        vm.expectRevert(abi.encodeWithSelector(CauceRelay.CauceRelay__WrongDestinationCaller.selector, bytes32(0)));
        relay.relayPayment(m.build(), ATTESTATION);
    }

    function test_ThirdPartyCannotReceiveRelayBoundMessage() public {
        bytes memory message = _payment().build();

        vm.prank(attacker);
        vm.expectRevert("Invalid caller for message");
        transmitter.receiveMessage(message, ATTESTATION);
    }

    function test_RevertsOnWrongDestinationDomain() public {
        CctpMessageBuilder.Message memory m = _payment();
        m.destinationDomain = 0;

        vm.expectRevert(abi.encodeWithSelector(CauceRelay.CauceRelay__WrongDestinationDomain.selector, uint32(0)));
        relay.relayPayment(m.build(), ATTESTATION);
    }

    function test_RevertsWhenMintedAmountDiffers() public {
        tokenMessenger.setMintShortfall(1);

        vm.expectRevert(
            abi.encodeWithSelector(CauceRelay.CauceRelay__UnexpectedMintAmount.selector, 1_010_000, 1_009_999)
        );
        relay.relayPayment(_payment().build(), ATTESTATION);
    }

    function test_RevertsOnTruncatedMessage() public {
        vm.expectRevert();
        relay.relayPayment(hex"0000000100000006", ATTESTATION);
    }
}
