// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {NexusVault} from "../src/NexusVault.sol";

contract DeployNexusVault is Script {
    function run() external {

        address usdcAddress = vm.envAddress("USDC_ADDRESS");
        address messageTransmitterAddress = vm.envAddress("MESSAGE_TRANSMITTER_ADDRESS");
        
        uint256 deployerPrivateKey = vm.envUint("DEPLOY_PRIVATE_KEY");
        
        vm.startBroadcast(deployerPrivateKey);

        NexusVault vault = new NexusVault(usdcAddress);

        console.log("NexusVault deployed to:", address(vault));
        console.log("USDC Address:", usdcAddress);
        console.log("MessageTransmitter Address:", messageTransmitterAddress);

        vm.stopBroadcast();
    }
}
