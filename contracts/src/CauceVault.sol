// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {HookData} from "./libraries/HookData.sol";

/// @title CauceVault
/// @notice Holds settled USDC payments on the settlement chain and tracks withdrawable balances
///         for merchants, referrers and refunded payers.
/// @dev Cross-chain payments arrive through CauceRelay, which verifies the CCTP message and the
///      minted amount before calling `settle`. Settlement never transfers tokens, so it cannot
///      revert on a recipient and leave a burned payment unsettled.
contract CauceVault {
    using SafeERC20 for IERC20;

    // --- Structs ---
    struct CampaignParams {
        uint256 referrerPct;
        address merchant;
        uint256 rewardLimit; // Max total rewards allowed
        uint256 totalRewarded; // Counter of rewards paid so far
        bool isActive;
    }

    // --- State Variables ---
    IERC20 public immutable USDC;
    address public immutable DEPLOYER;

    /// @notice The CauceRelay allowed to settle cross-chain payments (set once by the deployer).
    address public relay;

    mapping(uint256 campaignId => CampaignParams) public campaigns;
    uint256 public nextCampaignId;

    /// @notice Withdrawable USDC per account: merchant revenue, referral rewards and refunds.
    mapping(address account => uint256 usdcBalance) public balances;

    // --- Events ---
    event RelaySet(address indexed relay);
    event CampaignCreated(
        uint256 indexed campaignId, address indexed merchant, uint256 referrerPct, uint256 rewardLimit
    );
    event CampaignUpdated(uint256 indexed campaignId, uint256 referrerPct, uint256 rewardLimit, bool isActive);
    event PaymentReceived(address indexed merchant, uint256 amount, string orderId);
    event RewardPaid(uint256 indexed campaignId, address indexed referrer, uint256 amount);
    event CrossChainPaymentSettled(
        bytes32 indexed messageHash, address indexed merchant, uint32 sourceDomain, address payer, uint256 amount
    );
    event PaymentRefunded(bytes32 indexed messageHash, address indexed payer, uint256 amount);
    event FundsWithdrawn(address indexed account, uint256 amount);

    // --- Errors ---
    error CauceVault__InvalidSplit();
    error CauceVault__InvalidAmount();
    error CauceVault__InvalidHookData();
    error CauceVault__InsufficientBalance();
    error CauceVault__NotDeployer();
    error CauceVault__RelayAlreadySet();
    error CauceVault__ZeroAddress();
    error CauceVault__OnlyRelay();
    error CauceVault__NotCampaignOwner();

    constructor(address _usdc) {
        if (_usdc == address(0)) revert CauceVault__ZeroAddress();
        USDC = IERC20(_usdc);
        DEPLOYER = msg.sender;
    }

    // --- External Functions ---

    /// @notice Sets the CauceRelay address. Only the deployer, only once.
    function setRelay(address _relay) external {
        if (msg.sender != DEPLOYER) revert CauceVault__NotDeployer();
        if (relay != address(0)) revert CauceVault__RelayAlreadySet();
        if (_relay == address(0)) revert CauceVault__ZeroAddress();
        relay = _relay;
        emit RelaySet(_relay);
    }

    /// @notice Creates a referral campaign owned by the caller, capped at `rewardLimit`.
    function createReferralCampaign(uint256 referrerPct, uint256 rewardLimit) external returns (uint256 campaignId) {
        if (referrerPct > 100) revert CauceVault__InvalidSplit();
        if (rewardLimit == 0) revert CauceVault__InvalidAmount();

        campaignId = ++nextCampaignId;
        campaigns[campaignId] = CampaignParams({
            referrerPct: referrerPct, merchant: msg.sender, rewardLimit: rewardLimit, totalRewarded: 0, isActive: true
        });

        emit CampaignCreated(campaignId, msg.sender, referrerPct, rewardLimit);
    }

    /// @notice Activates or deactivates a campaign owned by the caller.
    function toggleCampaign(uint256 campaignId, bool isActive) external {
        CampaignParams storage campaign = campaigns[campaignId];
        if (campaign.merchant != msg.sender) revert CauceVault__NotCampaignOwner();
        campaign.isActive = isActive;
        emit CampaignUpdated(campaignId, campaign.referrerPct, campaign.rewardLimit, isActive);
    }

    /// @notice Updates the split and reward cap of a campaign owned by the caller.
    function updateCampaign(uint256 campaignId, uint256 referrerPct, uint256 rewardLimit) external {
        CampaignParams storage campaign = campaigns[campaignId];
        if (campaign.merchant != msg.sender) revert CauceVault__NotCampaignOwner();
        if (referrerPct > 100) revert CauceVault__InvalidSplit();
        if (rewardLimit == 0) revert CauceVault__InvalidAmount();

        campaign.referrerPct = referrerPct;
        campaign.rewardLimit = rewardLimit;
        emit CampaignUpdated(campaignId, referrerPct, rewardLimit, campaign.isActive);
    }

    /// @notice Direct payment on the settlement chain. `hookData` uses the same encoding as
    ///         cross-chain payments (see HookData).
    function pay(uint256 amount, bytes calldata hookData) external {
        if (amount == 0) revert CauceVault__InvalidAmount();
        (bool ok, HookData.Payload memory p) = HookData.tryDecode(hookData);
        if (!ok) revert CauceVault__InvalidHookData();

        USDC.safeTransferFrom(msg.sender, address(this), amount);
        _credit(amount, p);
    }

    /// @notice Settles a cross-chain payment whose USDC has already been minted to this vault.
    /// @param amount The amount actually minted (burn amount minus the CCTP fee executed).
    /// @param payer The source-chain account that burned the USDC; refunded if `hookData` is invalid.
    function settle(uint32 sourceDomain, bytes32 messageHash, address payer, uint256 amount, bytes calldata hookData)
        external
    {
        if (msg.sender != relay) revert CauceVault__OnlyRelay();

        (bool ok, HookData.Payload memory p) = HookData.tryDecode(hookData);
        if (!ok) {
            balances[payer] += amount;
            emit PaymentRefunded(messageHash, payer, amount);
            return;
        }

        _credit(amount, p);
        emit CrossChainPaymentSettled(messageHash, p.merchant, sourceDomain, payer, amount);
    }

    /// @notice Withdraws the caller's balance (merchant revenue, referral rewards or refunds).
    function withdraw(uint256 amount) external {
        if (balances[msg.sender] < amount) revert CauceVault__InsufficientBalance();

        balances[msg.sender] -= amount;
        USDC.safeTransfer(msg.sender, amount);

        emit FundsWithdrawn(msg.sender, amount);
    }

    // --- Internal Functions ---

    function _credit(uint256 amount, HookData.Payload memory p) internal {
        uint256 referralReward = HookData.hasReferral(p) ? _referralReward(amount, p) : 0;
        uint256 merchantShare = amount - referralReward;

        balances[p.merchant] += merchantShare;
        emit PaymentReceived(p.merchant, merchantShare, p.orderId);

        if (referralReward > 0) {
            balances[p.referrer] += referralReward;
            emit RewardPaid(p.campaignId, p.referrer, referralReward);
        }
    }

    /// @dev Referral only applies to an active campaign owned by the paid merchant, and the
    ///      reward is clamped to what is left of the campaign's limit.
    function _referralReward(uint256 amount, HookData.Payload memory p) internal returns (uint256 reward) {
        CampaignParams storage campaign = campaigns[p.campaignId];
        if (!campaign.isActive || campaign.merchant != p.merchant) return 0;

        reward = (amount * campaign.referrerPct) / 100;
        uint256 remaining =
            campaign.rewardLimit > campaign.totalRewarded ? campaign.rewardLimit - campaign.totalRewarded : 0;
        if (reward > remaining) reward = remaining;

        campaign.totalRewarded += reward;
    }
}
