// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployCauce} from "../script/DeployCauce.s.sol";
import {CauceVault} from "../src/CauceVault.sol";
import {CauceRelay} from "../src/CauceRelay.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockMessageTransmitter, MockTokenMessenger} from "./mocks/MockCctp.sol";

contract DeployCauceTest is Test {
    function test_DeploysAndWiresContracts() public {
        MockUSDC usdc = new MockUSDC();
        MockMessageTransmitter transmitter = new MockMessageTransmitter(26);
        MockTokenMessenger tokenMessenger = new MockTokenMessenger(address(transmitter), usdc);
        vm.setEnv("USDC_ADDRESS", vm.toString(address(usdc)));
        vm.setEnv("MESSAGE_TRANSMITTER_ADDRESS", vm.toString(address(transmitter)));
        vm.setEnv("TOKEN_MESSENGER_ADDRESS", vm.toString(address(tokenMessenger)));

        (CauceVault vault, CauceRelay relay) = new DeployCauce().run();

        assertEq(vault.relay(), address(relay));
        assertEq(address(relay.CAUCE_VAULT()), address(vault));
        assertEq(address(relay.TOKEN_MESSENGER()), address(tokenMessenger));
        assertEq(relay.LOCAL_DOMAIN(), 26);
    }
}
