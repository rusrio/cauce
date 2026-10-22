// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CauceVault} from "../src/CauceVault.sol";
import {HookData} from "../src/libraries/HookData.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract CauceVaultTest is Test {
    CauceVault internal vault;
    MockUSDC internal usdc;

    address internal relay = makeAddr("relay");
    address internal merchant = makeAddr("merchant");
    address internal referrer = makeAddr("referrer");
    address internal payer = makeAddr("payer");

    function setUp() public {
        usdc = new MockUSDC();
        vault = new CauceVault(address(usdc));
        vault.setRelay(relay);
    }

    function _hookData(string memory orderId) internal view returns (bytes memory) {
        return HookData.encode(HookData.Payload(merchant, orderId, 0, address(0)));
    }

    function _referralHookData(uint256 campaignId) internal view returns (bytes memory) {
        return HookData.encode(HookData.Payload(merchant, "order-ref", campaignId, referrer));
    }

    /// Simulates CauceRelay: USDC is minted to the vault, then settled.
    function _settle(uint256 amount, bytes memory hookData) internal {
        usdc.mint(address(vault), amount);
        _settleMinted(amount, hookData);
    }

    function _settleMinted(uint256 amount, bytes memory hookData) internal {
        vm.prank(relay);
        vault.settle(6, keccak256(hookData), payer, amount, hookData);
    }

    function _createCampaign(uint256 referrerPct, uint256 rewardLimit) internal returns (uint256 campaignId) {
        vm.prank(merchant);
        campaignId = vault.createReferralCampaign(referrerPct, rewardLimit);
    }

    // --- Relay setup ---

    function test_SetRelay_OnlyDeployer() public {
        CauceVault fresh = new CauceVault(address(usdc));

        vm.prank(makeAddr("frontrunner"));
        vm.expectRevert(CauceVault.CauceVault__NotDeployer.selector);
        fresh.setRelay(makeAddr("evil-relay"));
    }

    function test_SetRelay_OnlyOnce() public {
        vm.expectRevert(CauceVault.CauceVault__RelayAlreadySet.selector);
        vault.setRelay(makeAddr("other"));
    }

    function test_SetRelay_RejectsZero() public {
        CauceVault fresh = new CauceVault(address(usdc));
        vm.expectRevert(CauceVault.CauceVault__ZeroAddress.selector);
        fresh.setRelay(address(0));
    }

    // --- Cross-chain settlement ---

    function test_Settle_CreditsMintedAmount() public {
        bytes memory hookData = _hookData("order-1");
        usdc.mint(address(vault), 1_000_000);

        vm.expectEmit(address(vault));
        emit CauceVault.PaymentReceived(merchant, 1_000_000, "order-1");
        vm.expectEmit(address(vault));
        emit CauceVault.CrossChainPaymentSettled(keccak256(hookData), merchant, 6, payer, 1_000_000);
        _settleMinted(1_000_000, hookData);

        assertEq(vault.balances(merchant), 1_000_000);
    }

    function test_Settle_OnlyRelay() public {
        vm.expectRevert(CauceVault.CauceVault__OnlyRelay.selector);
        vault.settle(6, bytes32(0), payer, 1, _hookData("order-1"));
    }

    function test_Settle_RefundsPayerOnInvalidHookData() public {
        bytes memory legacy = abi.encode(merchant, "order-1");
        usdc.mint(address(vault), 500_000);

        vm.expectEmit(address(vault));
        emit CauceVault.PaymentRefunded(keccak256(legacy), payer, 500_000);
        _settleMinted(500_000, legacy);

        assertEq(vault.balances(payer), 500_000);
        assertEq(vault.balances(merchant), 0);

        vm.prank(payer);
        vault.withdraw(500_000);
        assertEq(usdc.balanceOf(payer), 500_000);
    }

    // --- Referrals ---

    function test_Referral_SplitsPayment() public {
        uint256 campaignId = _createCampaign(10, 1_000_000);

        _settle(1_000_000, _referralHookData(campaignId));

        assertEq(vault.balances(merchant), 900_000);
        assertEq(vault.balances(referrer), 100_000);
        (,,, uint256 totalRewarded,) = vault.campaigns(campaignId);
        assertEq(totalRewarded, 100_000);
    }

    function test_Referral_ClampedToRewardLimit() public {
        uint256 campaignId = _createCampaign(50, 300_000);

        _settle(1_000_000, _referralHookData(campaignId)); // reward 500k, capped at 300k
        _settle(1_000_000, _referralHookData(campaignId)); // limit exhausted

        assertEq(vault.balances(referrer), 300_000);
        assertEq(vault.balances(merchant), 1_700_000);
    }

    function test_Referral_IgnoredWhenInactive() public {
        uint256 campaignId = _createCampaign(10, 1_000_000);
        vm.prank(merchant);
        vault.toggleCampaign(campaignId, false);

        _settle(1_000_000, _referralHookData(campaignId));

        assertEq(vault.balances(merchant), 1_000_000);
        assertEq(vault.balances(referrer), 0);
    }

    function test_Referral_IgnoredForAnotherMerchantsCampaign() public {
        vm.prank(makeAddr("other-merchant"));
        uint256 campaignId = vault.createReferralCampaign(50, 1_000_000);

        _settle(1_000_000, _referralHookData(campaignId));

        assertEq(vault.balances(merchant), 1_000_000);
        assertEq(vault.balances(referrer), 0);
    }

    // --- Campaign management ---

    function test_CreateCampaign() public {
        uint256 campaignId = _createCampaign(10, 1000);

        (uint256 pct, address owner, uint256 limit, uint256 rewarded, bool active) = vault.campaigns(campaignId);
        assertEq(campaignId, 1);
        assertEq(pct, 10);
        assertEq(owner, merchant);
        assertEq(limit, 1000);
        assertEq(rewarded, 0);
        assertTrue(active);
    }

    function test_CreateCampaign_RejectsInvalidSplit() public {
        vm.expectRevert(CauceVault.CauceVault__InvalidSplit.selector);
        vault.createReferralCampaign(101, 1000);
    }

    function test_UpdateCampaign() public {
        uint256 campaignId = _createCampaign(10, 1000);

        vm.prank(merchant);
        vault.updateCampaign(campaignId, 20, 2000);

        (uint256 pct,, uint256 limit,,) = vault.campaigns(campaignId);
        assertEq(pct, 20);
        assertEq(limit, 2000);
    }

    function test_UpdateCampaign_OnlyOwner() public {
        uint256 campaignId = _createCampaign(10, 1000);

        vm.prank(referrer);
        vm.expectRevert(CauceVault.CauceVault__NotCampaignOwner.selector);
        vault.updateCampaign(campaignId, 20, 2000);
    }

    function test_ToggleCampaign_OnlyOwner() public {
        uint256 campaignId = _createCampaign(10, 1000);

        vm.prank(referrer);
        vm.expectRevert(CauceVault.CauceVault__NotCampaignOwner.selector);
        vault.toggleCampaign(campaignId, false);
    }

    // --- Direct payments ---

    function test_Pay_Direct() public {
        usdc.mint(payer, 2_000_000);
        vm.startPrank(payer);
        usdc.approve(address(vault), 2_000_000);
        vault.pay(2_000_000, _hookData("direct-1"));
        vm.stopPrank();

        assertEq(vault.balances(merchant), 2_000_000);
        assertEq(usdc.balanceOf(address(vault)), 2_000_000);
    }

    function test_Pay_RevertsOnInvalidHookData() public {
        vm.prank(payer);
        vm.expectRevert(CauceVault.CauceVault__InvalidHookData.selector);
        vault.pay(1, abi.encode(merchant, "order-1"));
    }

    function test_Pay_RevertsOnZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(CauceVault.CauceVault__InvalidAmount.selector);
        vault.pay(0, _hookData("direct-1"));
    }

    // --- Withdrawals ---

    function test_Withdraw() public {
        _settle(1_000_000, _hookData("order-1"));

        vm.prank(merchant);
        vault.withdraw(400_000);

        assertEq(usdc.balanceOf(merchant), 400_000);
        assertEq(vault.balances(merchant), 600_000);
    }

    function test_Withdraw_RevertsAboveBalance() public {
        _settle(1_000_000, _hookData("order-1"));

        vm.prank(merchant);
        vm.expectRevert(CauceVault.CauceVault__InsufficientBalance.selector);
        vault.withdraw(1_000_001);
    }
}
