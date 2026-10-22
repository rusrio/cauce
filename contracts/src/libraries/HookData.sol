// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title HookData
/// @notice Cauce payment metadata carried in the CCTP `hookData` field.
/// @dev Version 1 is the canonical ABI encoding of
///      `(uint8 version, address merchant, string orderId, uint256 campaignId, address referrer)`,
///      with `campaignId == 0` and `referrer == address(0)` when there is no referral.
///      `tryDecode` validates the encoding by hand so malformed input never reverts; the vault
///      relies on that to refund the payer instead of leaving a burned payment unsettled.
library HookData {
    uint8 internal constant VERSION = 1;
    uint256 internal constant MAX_ORDER_ID_LENGTH = 128;

    uint256 private constant HEAD_LENGTH = 5 * 32;
    uint256 private constant STRING_OFFSET = HEAD_LENGTH;

    struct Payload {
        address merchant;
        string orderId;
        uint256 campaignId;
        address referrer;
    }

    function encode(Payload memory p) internal pure returns (bytes memory) {
        return abi.encode(VERSION, p.merchant, p.orderId, p.campaignId, p.referrer);
    }

    function tryDecode(bytes calldata data) internal pure returns (bool ok, Payload memory p) {
        if (data.length < HEAD_LENGTH + 32) return (false, p);

        uint256 version = _word(data, 0);
        uint256 merchant = _word(data, 1);
        uint256 offset = _word(data, 2);
        uint256 campaignId = _word(data, 3);
        uint256 referrer = _word(data, 4);
        uint256 length = uint256(bytes32(data[STRING_OFFSET:STRING_OFFSET + 32]));

        if (version != VERSION) return (false, p);
        if (merchant == 0 || merchant > type(uint160).max) return (false, p);
        if (referrer > type(uint160).max) return (false, p);
        if (offset != STRING_OFFSET) return (false, p);
        if (length == 0 || length > MAX_ORDER_ID_LENGTH) return (false, p);
        if (data.length != HEAD_LENGTH + 32 + _ceil32(length)) return (false, p);

        p.merchant = address(uint160(merchant));
        p.orderId = string(data[STRING_OFFSET + 32:STRING_OFFSET + 32 + length]);
        p.campaignId = campaignId;
        p.referrer = address(uint160(referrer));
        return (true, p);
    }

    function hasReferral(Payload memory p) internal pure returns (bool) {
        return p.campaignId != 0 && p.referrer != address(0);
    }

    function _word(bytes calldata data, uint256 index) private pure returns (uint256) {
        return uint256(bytes32(data[index * 32:(index + 1) * 32]));
    }

    function _ceil32(uint256 length) private pure returns (uint256) {
        return (length + 31) / 32 * 32;
    }
}
