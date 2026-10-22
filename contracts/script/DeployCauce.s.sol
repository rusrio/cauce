// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {CauceVault} from "../src/CauceVault.sol";
import {CauceRelay} from "../src/CauceRelay.sol";

/// @notice Deploys CauceVault and CauceRelay on the settlement chain and wires them together.
/// @dev Every address comes from the environment; see contracts/.env.example.
///      forge script script/DeployCauce.s.sol --rpc-url $RPC_URL --account <keystore> --broadcast
contract DeployCauce is Script {
    function run() external returns (CauceVault vault, CauceRelay relay) {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address messageTransmitter = vm.envAddress("MESSAGE_TRANSMITTER_ADDRESS");
        address tokenMessenger = vm.envAddress("TOKEN_MESSENGER_ADDRESS");

        vm.startBroadcast();
        vault = new CauceVault(usdc);
        relay = new CauceRelay(messageTransmitter, tokenMessenger, address(vault));
        vault.setRelay(address(relay));
        vm.stopBroadcast();

        require(vault.relay() == address(relay), "relay not set");
        require(address(relay.CAUCE_VAULT()) == address(vault), "vault mismatch");
        require(address(relay.USDC()) == usdc, "usdc mismatch");

        console.log("CauceVault:", address(vault));
        console.log("CauceRelay:", address(relay));
        console.log("Local CCTP domain:", relay.LOCAL_DOMAIN());
    }
}
