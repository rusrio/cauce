// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {CauceRelay} from "../src/CauceRelay.sol";
import {CauceVault} from "../src/CauceVault.sol";

contract DeployCauceRelay is Script {
    // Arc Testnet addresses
    address constant MESSAGE_TRANSMITTER = 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275;
    address constant CAUCE_VAULT = 0x05949CFfCE00B0032194cb7B8f8e72bBF1376012;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOY_PRIVATE_KEY");
        
        vm.startBroadcast(deployerPrivateKey);

        // Deploy CauceRelay
        CauceRelay relay = new CauceRelay(MESSAGE_TRANSMITTER, CAUCE_VAULT);

        console.log("=================================================");
        console.log("CauceRelay deployed to:", address(relay));
        console.log("=================================================");
        console.log("Configuration:");
        console.log("  MessageTransmitter:", MESSAGE_TRANSMITTER);
        console.log("  CauceVault:", CAUCE_VAULT);
        console.log("=================================================");

        // Configure CauceVault to accept calls from relay
        CauceVault vault = CauceVault(CAUCE_VAULT);
        vault.setRelay(address(relay));

        console.log("CauceVault configured with relay address");
        console.log("=================================================");

        // Verify configuration
        (address mt, address nv) = relay.getConfiguration();
        address configuredRelay = vault.relay();
        
        console.log("Verification:");
        console.log("  Relay MessageTransmitter:", mt);
        console.log("  Relay CauceVault:", nv);
        console.log("  Vault relay:", configuredRelay);
        console.log("=================================================");

        require(configuredRelay == address(relay), "Configuration failed");
        console.log("Deployment and configuration successful!");

        vm.stopBroadcast();
    }
}
