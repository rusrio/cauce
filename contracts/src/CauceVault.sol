// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";



contract CauceVault {
    using SafeERC20 for IERC20;

    // --- Structs ---
    struct CampaignParams {
        uint256 referrerPct;
        address merchant;
        uint256 rewardLimit;   // Max total rewards allowed
        uint256 totalRewarded; // Counter of rewards paid so far
        bool isActive;
    }

    // --- State Variables ---
    IERC20 public immutable USDC;
    
    mapping(uint256 campaignId => CampaignParams) public campaigns;
    uint256 public nextCampaignId;

    mapping(address merchantAddress => uint256 usdcBalance) public merchantBalances;
    
    // CauceRelay contract address (can only be set once)
    address public relay;

    // --- Events ---
    event CampaignCreated(
        uint256 indexed campaignId,
        address indexed merchant,
        uint256 referrerPct,
        uint256 rewardLimit
    );
    event PaymentReceived(
        address indexed merchant,
        uint256 amount,
        string orderId
    );
    event RewardPaid(
        uint256 indexed campaignId,
        address indexed referrer,
        uint256 amount
    );
    event FundsWithdrawn(
        address indexed merchant,
        uint256 amount
    );
    event CCTPPaymentProcessed(
        address indexed merchant,
        uint256 amount,
        string orderId,
        bytes32 messageHash
    );

    // --- Errors ---
    error CauceVault__InvalidSplit();
    error CauceVault__CampaignNotFound();
    error CauceVault__CampaignInactive();
    error CauceVault__InvalidAmount();
    error CauceVault__InsufficientBalance();
    error CauceVault__RewardLimitReached();
    error CauceVault__InvalidMessageFormat();
    error CauceVault__CCTPReceiveFailed();
    error CauceVault__OnlyRelay();
    error CauceVault__UnfinalizedMessagesNotSupported();
    error CauceVault__AmountTooSmallToCoverFee();
    error CauceVault__NotCampaignOwner();

    constructor(address _usdc) {
        USDC = IERC20(_usdc);
    }

    // --- External Functions ---

    /**
     * @notice Sets the CauceRelay contract address (one-time only)
     * @dev Can only be called once to prevent changing the relay after deployment
     * @param _relay Address of the CauceRelay contract
     */
    function setRelay(address _relay) external {
        require(relay == address(0), CauceVault__OnlyRelay());
        require(_relay != address(0), CauceVault__InvalidMessageFormat());
        relay = _relay;
    }

    // Create a new referral campaign with a reward limit cap
    function createReferralCampaign(
        uint256 referrerPct,
        uint256 rewardLimit
    ) external returns (uint256 campaignId) {
        if (referrerPct > 100) revert CauceVault__InvalidSplit();
        if (rewardLimit == 0) revert CauceVault__InvalidAmount();

        campaignId = ++nextCampaignId;
        campaigns[campaignId] = CampaignParams({
            referrerPct: referrerPct,
            merchant: msg.sender,
            rewardLimit: rewardLimit,
            totalRewarded: 0,
            isActive: true
        });

        emit CampaignCreated(
            campaignId,
            msg.sender,
            referrerPct,
            rewardLimit
        );
    }

    /**
     * @notice Toggle campaign active status
     * @param campaignId ID of the campaign
     * @param isActive New active status
     */
    function toggleCampaign(uint256 campaignId, bool isActive) external {
        CampaignParams storage campaign = campaigns[campaignId];
        require(campaign.merchant == msg.sender, CauceVault__NotCampaignOwner());
        campaign.isActive = isActive;
    }

    /**
     * @notice Update campaign parameters
     * @param campaignId ID of the campaign
     * @param referrerPct New referrer percentage
     * @param rewardLimit New reward limit
     */
    function updateCampaign(
        uint256 campaignId,
        uint256 referrerPct,
        uint256 rewardLimit
    ) external {
        CampaignParams storage campaign = campaigns[campaignId];
        require(campaign.merchant == msg.sender, CauceVault__NotCampaignOwner());
        if (referrerPct > 100) revert CauceVault__InvalidSplit();
        if (rewardLimit == 0) revert CauceVault__InvalidAmount();
        
        campaign.referrerPct = referrerPct;
        campaign.rewardLimit = rewardLimit;
    }

    // Standard payment (no referral), and no cross-chain (direct payment)
    function pay(
        uint256 amount,
        address merchant,
        string memory orderId
    ) external {
        if (amount == 0) revert CauceVault__InvalidAmount();

        USDC.safeTransferFrom(msg.sender, address(this), amount);
        _processPay(amount, merchant, orderId);
    }
    
    function handleReceiveFinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        bytes calldata messageBody
    ) external returns (bool) {
        // Only CauceRelay can call this function
        require(msg.sender == relay, CauceVault__OnlyRelay());
        
        uint256 amount = _extractAmountFromBurnMessage(messageBody);
        bytes memory hookData = _extractHookDataFromBurnMessage(messageBody);
        
        // Decode merchant address and orderId from hookData
        (address merchant, string memory orderId) = abi.decode(
            hookData,
            (address, string)
        );

        // Deduct CCTP protocol fee (0.02 USDC = 20000 wei in 6 decimals)
        // The user pays amount + fee, but merchant receives only amount
        uint256 protocolFee = 20000; // 0.02 USDC
        require(amount > protocolFee, CauceVault__AmountTooSmallToCoverFee());
        uint256 merchantAmount = amount - protocolFee;

        address referrer = address(0);
        uint256 campaignId = 0;
        
        if (hookData.length > 64) {
            try this.decodeReferralParams(hookData) returns (address _m, string memory /*_o*/, uint256 _c, address _r) {
                 if (_m == merchant) { // Should match
                     campaignId = _c;
                     referrer = _r;
                 }
            } catch {
                // formatting differs, ignore referral
            }
        }

        if (campaignId > 0 && referrer != address(0)) {
            _processPayWithReferral(merchantAmount, merchant, orderId, campaignId, referrer);
        } else {
            _processPay(merchantAmount, merchant, orderId);
        }
        
        emit CCTPPaymentProcessed(
            merchant,
            merchantAmount, // Event shows merchant amount (without fee)
            orderId,
            keccak256(abi.encodePacked(sourceDomain, sender, messageBody))
        );
        
        return true;
    }

    // Withdraw merchant earnings to their wallet (on Arc Testnet)
    function withdraw(uint256 amount) external {
        if (merchantBalances[msg.sender] < amount)
            revert CauceVault__InsufficientBalance();

        merchantBalances[msg.sender] -= amount;
        USDC.safeTransfer(msg.sender, amount);

        emit FundsWithdrawn(msg.sender, amount);
    }

    // --- Internal Functions ---

    /**
     * @notice Processes a payment
     * @param amount The net payment amount (after protocol fees)
     * @param merchant The merchant address receiving the payment
     * @param orderId The unique order identifier
     */
    function _processPay(
        uint256 amount,
        address merchant,
        string memory orderId
    ) internal {
        merchantBalances[merchant] += amount;
        emit PaymentReceived(merchant, amount, orderId);
    }

    /**
     * @notice Processes a payment that includes referral information
     * @dev Calculates the referral reward based on campaign settings.
     * @param amount The net payment amount (after protocol fees)
     * @param merchant The merchant address receiving the payment
     * @param orderId The unique order identifier
     * @param campaignId The ID of the referral campaign
     * @param referrer The address of the referrer to be rewarded
     */
    function _processPayWithReferral(
        uint256 amount,
        address merchant,
        string memory orderId,
        uint256 campaignId,
        address referrer
    ) internal {
        CampaignParams storage campaign = campaigns[campaignId];

        if (!campaign.isActive) {
             _processPay(amount, merchant, orderId);
             return;
        }
        if (campaign.merchant != merchant) {
             _processPay(amount, merchant, orderId);
             return;
        }
        
        uint256 referralReward = (amount * campaign.referrerPct) / 100;
        
        if (campaign.totalRewarded + referralReward > campaign.rewardLimit) {
            uint256 remaining = campaign.rewardLimit > campaign.totalRewarded 
                ? campaign.rewardLimit - campaign.totalRewarded 
                : 0;
            referralReward = remaining;
        }

        campaign.totalRewarded += referralReward;
        uint256 merchantShare = amount - referralReward;

        merchantBalances[merchant] += merchantShare;
        if (referralReward > 0) {
            USDC.safeTransfer(referrer, referralReward);
        }

        emit PaymentReceived(merchant, merchantShare, orderId);
        emit RewardPaid(campaignId, referrer, referralReward);
    }

    /** 
     * @notice Helper to decode params with referral
     * @dev Made external so we can use try/catch in this contract context
     */
    function decodeReferralParams(bytes memory data) external pure returns (address, string memory, uint256, address) {
        return abi.decode(data, (address, string, uint256, address));
    }

    /**
     * @notice Extracts hookData from BurnMessage
     * @dev HookData starts at offset 228 in the BurnMessage
     * @param messageBody The BurnMessage bytes (NOT full CCTP message)
     */
    function _extractHookDataFromBurnMessage(bytes calldata messageBody) internal pure returns (bytes memory) {
        uint256 hookDataOffset = 228;
        
        if (messageBody.length <= hookDataOffset) {
            revert CauceVault__InvalidMessageFormat();
        }
        
        return messageBody[hookDataOffset:];
    }

    /**
     * @notice Extracts amount from BurnMessage
     * @dev Amount is at offset 68 in the BurnMessage
     * @param messageBody The BurnMessage bytes (NOT full CCTP message)
     */
    function _extractAmountFromBurnMessage(bytes calldata messageBody) internal pure returns (uint256) {
        uint256 amountOffset = 68;
        
        if (messageBody.length < amountOffset + 32) {
            revert CauceVault__InvalidMessageFormat();
        }
        
        return abi.decode(messageBody[amountOffset:amountOffset + 32], (uint256));
    }

}
