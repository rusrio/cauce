// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {NexusVault} from "../src/NexusVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USDC", "USDC") {
        _mint(msg.sender, 1000000 * 10**6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract NexusVaultTest is Test {
    NexusVault public vault;
    MockUSDC public usdc;
    
    address public merchant = makeAddr("merchant");
    address public referrer = makeAddr("referrer");
    address public relayer = address(this); // Test contract acts as relayer

    function setUp() public {
        usdc = new MockUSDC();
        vault = new NexusVault(address(usdc));
        vault.setNexusPayRelay(relayer);
        
        // Fund vault so it can pay out (simulating CCTP backing)
        // In reality, CCTP mints to Vault, then Vault credits internal balance.
        // Wait, NexusVault logic:
        // handleReceiveFinalizedMessage -> credits internal `merchantBalances`.
        // withdraw -> transfers USDC from Vault to user.
        // So Vault needs USDC balance to support withdrawals.
        usdc.transfer(address(vault), 100000 * 10**6);
    }

    function testCreateCampaign() public {
        vm.prank(merchant);
        uint256 campaignId = vault.createReferralCampaign(10, 1000 * 10**6);
        
        (uint256 pct, address owner, uint256 limit, uint256 total, bool active) = vault.campaigns(campaignId);
        
        assertEq(pct, 10);
        assertEq(owner, merchant);
        assertEq(limit, 1000 * 10**6);
        assertEq(total, 0);
        assertTrue(active);
    }

    function testToggleCampaign() public {
        vm.prank(merchant);
        uint256 campaignId = vault.createReferralCampaign(10, 1000);
        
        vm.prank(merchant);
        vault.toggleCampaign(campaignId, false);
        
        (,,,, bool active) = vault.campaigns(campaignId);
        assertFalse(active);
    }

    function testUpdateCampaign() public {
        vm.prank(merchant);
        uint256 campaignId = vault.createReferralCampaign(10, 1000);
        
        vm.prank(merchant);
        vault.updateCampaign(campaignId, 20, 2000);
        
        (uint256 pct,, uint256 limit,,) = vault.campaigns(campaignId);
        assertEq(pct, 20);
        assertEq(limit, 2000);
    }

    function testRevertUpdateCampaignNotOwner() public {
        vm.prank(merchant);
        uint256 campaignId = vault.createReferralCampaign(10, 1000);
        
        vm.expectRevert("Not campaign owner");
        vm.prank(referrer); // Wrong user
        vault.updateCampaign(campaignId, 20, 2000);
    }

    function testProcessReferralPayment() public {
        // Setup campaign
        vm.prank(merchant);
        uint256 campaignId = vault.createReferralCampaign(10, 1000 * 10**6); // 10% referral

        uint256 amount = 100 * 10**6 + 20000; // 100 USDC + fee
        string memory orderId = "ORDER-123";
        
        bytes memory messageBody = _createBurnMessage(amount, merchant, orderId, campaignId, referrer);
        
        // Relayer calls handleReceiveFinalizedMessage
        vault.handleReceiveFinalizedMessage(
            1, // sourceDomain
            bytes32(0), // sender
            messageBody
        );
        
        // Check balances
        // Protocol fee: 20000
        // Net amount: 100 USDC
        // Referral: 10% of 100 = 10 USDC
        // Merchant: 90 USDC
        
        assertEq(vault.merchantBalances(merchant), 90 * 10**6);
        assertEq(vault.merchantBalances(merchant), 90 * 10**6);
        assertEq(vault.merchantBalances(referrer), 0); // Not stored in vault anymore
        assertEq(usdc.balanceOf(referrer), 10 * 10**6); // Received directly
    }

    function testReferralCap() public {
         // Setup campaign with small limit (5 USDC)
        vm.prank(merchant);
        uint256 campaignId = vault.createReferralCampaign(10, 5 * 10**6); 

        uint256 amount = 100 * 10**6 + 20000; // 100 USDC + fee
        // 10% would be 10 USDC, but limit is 5.
        
        bytes memory messageBody = _createBurnMessage(amount, merchant, "ORDER-CAP", campaignId, referrer);
        
        vault.handleReceiveFinalizedMessage(1, bytes32(0), messageBody);
        
        assertEq(vault.merchantBalances(referrer), 0);
        assertEq(usdc.balanceOf(referrer), 5 * 10**6); // Capped at 5 received directly
        assertEq(vault.merchantBalances(merchant), 95 * 10**6); // 100 - 5
    }

    function testInactiveCampaign() public {
        vm.prank(merchant);
        uint256 campaignId = vault.createReferralCampaign(10, 1000 * 10**6);
        vm.prank(merchant);
        vault.toggleCampaign(campaignId, false); // Deactivate

        uint256 amount = 100 * 10**6 + 20000;
        
        bytes memory messageBody = _createBurnMessage(amount, merchant, "ORDER-INACTIVE", campaignId, referrer);
        
        vault.handleReceiveFinalizedMessage(1, bytes32(0), messageBody);
        
        assertEq(vault.merchantBalances(referrer), 0);
        assertEq(vault.merchantBalances(merchant), 100 * 10**6); // Full amount
    }

    // --- Helpers ---
    
    function _createBurnMessage(
        uint256 amount, 
        address _merchant, 
        string memory _orderId,
        uint256 _campaignId,
        address _referrer
    ) internal pure returns (bytes memory) {
        // BurnMessage format construction
        // 0-68: Header/padding (we just need amount at 68)
        // 68: Amount (32 bytes)
        // 100-228: Padding/other fields
        // 228: Hook Data
        
        bytes memory prefix = new bytes(68);
        bytes memory amountBytes = abi.encode(amount);
        bytes memory middle = new bytes(228 - (68 + 32));
        
        bytes memory hookData;
        if (_campaignId > 0) {
            hookData = abi.encode(_merchant, _orderId, _campaignId, _referrer);
        } else {
            hookData = abi.encode(_merchant, _orderId);
        }
        
        return abi.encodePacked(
            prefix,
            amountBytes,
            middle,
            hookData
        );
    }
}
