import { parseAbi } from 'viem';

/** Subset of Circle's CCTP V2 TokenMessengerV2 used to pay. */
export const tokenMessengerV2Abi = parseAbi([
  'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
]);

/** Subset of Circle's CCTP V2 MessageTransmitterV2 used to check settlement state. */
export const messageTransmitterV2Abi = parseAbi([
  'function localDomain() view returns (uint32)',
  'function usedNonces(bytes32 nonce) view returns (uint256)',
]);
