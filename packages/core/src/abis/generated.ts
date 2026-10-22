//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CauceRelay
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cauceRelayAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_messageTransmitter', internalType: 'address', type: 'address' },
      { name: '_tokenMessenger', internalType: 'address', type: 'address' },
      { name: '_cauceVault', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'CAUCE_VAULT',
    outputs: [{ name: '', internalType: 'contract ICauceVault', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'LOCAL_DOMAIN',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'MESSAGE_TRANSMITTER',
    outputs: [{ name: '', internalType: 'contract IMessageTransmitterV2', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'TOKEN_MESSENGER',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'USDC',
    outputs: [{ name: '', internalType: 'contract IERC20', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'message', internalType: 'bytes', type: 'bytes' },
      { name: 'attestation', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'relayPayment',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'messageHash', internalType: 'bytes32', type: 'bytes32', indexed: true },
      { name: 'sourceDomain', internalType: 'uint32', type: 'uint32', indexed: true },
      { name: 'nonce', internalType: 'bytes32', type: 'bytes32', indexed: false },
      { name: 'amount', internalType: 'uint256', type: 'uint256', indexed: false },
    ],
    name: 'PaymentRelayed',
  },
  { type: 'error', inputs: [], name: 'CauceRelay__FeeExceedsAmount' },
  { type: 'error', inputs: [], name: 'CauceRelay__ReceiveMessageFailed' },
  {
    type: 'error',
    inputs: [
      { name: 'expected', internalType: 'uint256', type: 'uint256' },
      { name: 'actual', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'CauceRelay__UnexpectedMintAmount',
  },
  {
    type: 'error',
    inputs: [{ name: 'destinationCaller', internalType: 'bytes32', type: 'bytes32' }],
    name: 'CauceRelay__WrongDestinationCaller',
  },
  {
    type: 'error',
    inputs: [{ name: 'domain', internalType: 'uint32', type: 'uint32' }],
    name: 'CauceRelay__WrongDestinationDomain',
  },
  {
    type: 'error',
    inputs: [{ name: 'mintRecipient', internalType: 'bytes32', type: 'bytes32' }],
    name: 'CauceRelay__WrongMintRecipient',
  },
  {
    type: 'error',
    inputs: [{ name: 'recipient', internalType: 'bytes32', type: 'bytes32' }],
    name: 'CauceRelay__WrongRecipient',
  },
  { type: 'error', inputs: [], name: 'CauceRelay__ZeroAddress' },
  {
    type: 'error',
    inputs: [{ name: 'length', internalType: 'uint256', type: 'uint256' }],
    name: 'CctpMessage__TooShort',
  },
] as const;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CauceVault
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cauceVaultAbi = [
  {
    type: 'constructor',
    inputs: [{ name: '_usdc', internalType: 'address', type: 'address' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'DEPLOYER',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'USDC',
    outputs: [{ name: '', internalType: 'contract IERC20', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'account', internalType: 'address', type: 'address' }],
    name: 'balances',
    outputs: [{ name: 'usdcBalance', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'campaignId', internalType: 'uint256', type: 'uint256' }],
    name: 'campaigns',
    outputs: [
      { name: 'referrerPct', internalType: 'uint256', type: 'uint256' },
      { name: 'merchant', internalType: 'address', type: 'address' },
      { name: 'rewardLimit', internalType: 'uint256', type: 'uint256' },
      { name: 'totalRewarded', internalType: 'uint256', type: 'uint256' },
      { name: 'isActive', internalType: 'bool', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'referrerPct', internalType: 'uint256', type: 'uint256' },
      { name: 'rewardLimit', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'createReferralCampaign',
    outputs: [{ name: 'campaignId', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'nextCampaignId',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
      { name: 'hookData', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'pay',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'relay',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_relay', internalType: 'address', type: 'address' }],
    name: 'setRelay',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'sourceDomain', internalType: 'uint32', type: 'uint32' },
      { name: 'messageHash', internalType: 'bytes32', type: 'bytes32' },
      { name: 'payer', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
      { name: 'hookData', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'settle',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'campaignId', internalType: 'uint256', type: 'uint256' },
      { name: 'isActive', internalType: 'bool', type: 'bool' },
    ],
    name: 'toggleCampaign',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'campaignId', internalType: 'uint256', type: 'uint256' },
      { name: 'referrerPct', internalType: 'uint256', type: 'uint256' },
      { name: 'rewardLimit', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'updateCampaign',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'amount', internalType: 'uint256', type: 'uint256' }],
    name: 'withdraw',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'campaignId', internalType: 'uint256', type: 'uint256', indexed: true },
      { name: 'merchant', internalType: 'address', type: 'address', indexed: true },
      { name: 'referrerPct', internalType: 'uint256', type: 'uint256', indexed: false },
      { name: 'rewardLimit', internalType: 'uint256', type: 'uint256', indexed: false },
    ],
    name: 'CampaignCreated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'campaignId', internalType: 'uint256', type: 'uint256', indexed: true },
      { name: 'referrerPct', internalType: 'uint256', type: 'uint256', indexed: false },
      { name: 'rewardLimit', internalType: 'uint256', type: 'uint256', indexed: false },
      { name: 'isActive', internalType: 'bool', type: 'bool', indexed: false },
    ],
    name: 'CampaignUpdated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'messageHash', internalType: 'bytes32', type: 'bytes32', indexed: true },
      { name: 'merchant', internalType: 'address', type: 'address', indexed: true },
      { name: 'sourceDomain', internalType: 'uint32', type: 'uint32', indexed: false },
      { name: 'payer', internalType: 'address', type: 'address', indexed: false },
      { name: 'amount', internalType: 'uint256', type: 'uint256', indexed: false },
    ],
    name: 'CrossChainPaymentSettled',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'account', internalType: 'address', type: 'address', indexed: true },
      { name: 'amount', internalType: 'uint256', type: 'uint256', indexed: false },
    ],
    name: 'FundsWithdrawn',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'merchant', internalType: 'address', type: 'address', indexed: true },
      { name: 'amount', internalType: 'uint256', type: 'uint256', indexed: false },
      { name: 'orderId', internalType: 'string', type: 'string', indexed: false },
    ],
    name: 'PaymentReceived',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'messageHash', internalType: 'bytes32', type: 'bytes32', indexed: true },
      { name: 'payer', internalType: 'address', type: 'address', indexed: true },
      { name: 'amount', internalType: 'uint256', type: 'uint256', indexed: false },
    ],
    name: 'PaymentRefunded',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [{ name: 'relay', internalType: 'address', type: 'address', indexed: true }],
    name: 'RelaySet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'campaignId', internalType: 'uint256', type: 'uint256', indexed: true },
      { name: 'referrer', internalType: 'address', type: 'address', indexed: true },
      { name: 'amount', internalType: 'uint256', type: 'uint256', indexed: false },
    ],
    name: 'RewardPaid',
  },
  { type: 'error', inputs: [], name: 'CauceVault__InsufficientBalance' },
  { type: 'error', inputs: [], name: 'CauceVault__InvalidAmount' },
  { type: 'error', inputs: [], name: 'CauceVault__InvalidHookData' },
  { type: 'error', inputs: [], name: 'CauceVault__InvalidSplit' },
  { type: 'error', inputs: [], name: 'CauceVault__NotCampaignOwner' },
  { type: 'error', inputs: [], name: 'CauceVault__NotDeployer' },
  { type: 'error', inputs: [], name: 'CauceVault__OnlyRelay' },
  { type: 'error', inputs: [], name: 'CauceVault__RelayAlreadySet' },
  { type: 'error', inputs: [], name: 'CauceVault__ZeroAddress' },
  {
    type: 'error',
    inputs: [{ name: 'token', internalType: 'address', type: 'address' }],
    name: 'SafeERC20FailedOperation',
  },
] as const;
