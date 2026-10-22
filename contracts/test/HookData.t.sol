// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {HookData} from "../src/libraries/HookData.sol";

contract HookDataHarness {
    function tryDecode(bytes calldata data) external pure returns (bool, HookData.Payload memory) {
        return HookData.tryDecode(data);
    }

    function encode(HookData.Payload memory p) external pure returns (bytes memory) {
        return HookData.encode(p);
    }
}

contract HookDataTest is Test {
    // Fields in alphabetical order, as vm.parseJson decodes objects.
    struct ValidVector {
        string campaignId;
        bytes encoded;
        address merchant;
        string name;
        string orderId;
        address referrer;
    }

    struct InvalidVector {
        bytes encoded;
        string name;
    }

    HookDataHarness internal harness = new HookDataHarness();
    string internal fixture;

    function setUp() public {
        fixture = vm.readFile("test/fixtures/hook-data.json");
    }

    function test_SharedFixture_Valid() public view {
        ValidVector[] memory vectors = abi.decode(vm.parseJson(fixture, ".valid"), (ValidVector[]));
        assertGt(vectors.length, 0);
        for (uint256 i; i < vectors.length; i++) {
            ValidVector memory v = vectors[i];
            (bool ok, HookData.Payload memory p) = harness.tryDecode(v.encoded);
            assertTrue(ok, v.name);
            assertEq(p.merchant, v.merchant, v.name);
            assertEq(p.orderId, v.orderId, v.name);
            assertEq(p.campaignId, vm.parseUint(v.campaignId), v.name);
            assertEq(p.referrer, v.referrer, v.name);
            assertEq(harness.encode(p), v.encoded, v.name);
        }
    }

    function test_SharedFixture_Invalid() public view {
        InvalidVector[] memory vectors = abi.decode(vm.parseJson(fixture, ".invalid"), (InvalidVector[]));
        assertGt(vectors.length, 0);
        for (uint256 i; i < vectors.length; i++) {
            (bool ok,) = harness.tryDecode(vectors[i].encoded);
            assertFalse(ok, vectors[i].name);
        }
    }

    function testFuzz_RoundTrip(address merchant, string calldata orderId, uint256 campaignId, address referrer)
        public
        view
    {
        vm.assume(merchant != address(0));
        vm.assume(bytes(orderId).length > 0 && bytes(orderId).length <= HookData.MAX_ORDER_ID_LENGTH);
        HookData.Payload memory input = HookData.Payload(merchant, orderId, campaignId, referrer);

        (bool ok, HookData.Payload memory output) = harness.tryDecode(harness.encode(input));

        assertTrue(ok);
        assertEq(output.merchant, merchant);
        assertEq(output.orderId, orderId);
        assertEq(output.campaignId, campaignId);
        assertEq(output.referrer, referrer);
    }

    /// Malformed input must never revert: the vault turns it into a refund.
    function testFuzz_NeverReverts(bytes calldata data) public view {
        harness.tryDecode(data);
    }
}
