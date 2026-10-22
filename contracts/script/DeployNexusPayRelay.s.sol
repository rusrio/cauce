// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {NexusPayRelay} from "../src/NexusPayRelay.sol";
import {NexusVault} from "../src/NexusVault.sol";

contract DeployNexusPayRelay is Script {
    // Arc Testnet addresses
    address constant MESSAGE_TRANSMITTER = 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275;
    address constant NEXUS_VAULT = 0x05949CFfCE00B0032194cb7B8f8e72bBF1376012;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOY_PRIVATE_KEY");
        
        vm.startBroadcast(deployerPrivateKey);

        // Deploy NexusPayRelay
        NexusPayRelay relay = new NexusPayRelay(MESSAGE_TRANSMITTER, NEXUS_VAULT);

        console.log("=================================================");
        console.log("NexusPayRelay deployed to:", address(relay));
        console.log("=================================================");
        console.log("Configuration:");
        console.log("  MessageTransmitter:", MESSAGE_TRANSMITTER);
        console.log("  NexusVault:", NEXUS_VAULT);
        console.log("=================================================");

        // Configure NexusVault to accept calls from relay
        NexusVault vault = NexusVault(NEXUS_VAULT);
        vault.setNexusPayRelay(address(relay));

        console.log("NexusVault configured with relay address");
        console.log("=================================================");

        // Verify configuration
        (address mt, address nv) = relay.getConfiguration();
        address configuredRelay = vault.nexusPayRelay();
        
        console.log("Verification:");
        console.log("  Relay MessageTransmitter:", mt);
        console.log("  Relay NexusVault:", nv);
        console.log("  Vault nexusPayRelay:", configuredRelay);
        console.log("=================================================");

        require(configuredRelay == address(relay), "Configuration failed");
        console.log("Deployment and configuration successful!");

        vm.stopBroadcast();
    }
}
