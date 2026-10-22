// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {CauceVault} from "../src/CauceVault.sol";

contract DeployCauceVault is Script {
    function run() external {

        address usdcAddress = vm.envAddress("USDC_ADDRESS");
        address messageTransmitterAddress = vm.envAddress("MESSAGE_TRANSMITTER_ADDRESS");
        
        uint256 deployerPrivateKey = vm.envUint("DEPLOY_PRIVATE_KEY");
        
        vm.startBroadcast(deployerPrivateKey);

        CauceVault vault = new CauceVault(usdcAddress);

        console.log("CauceVault deployed to:", address(vault));
        console.log("USDC Address:", usdcAddress);
        console.log("MessageTransmitter Address:", messageTransmitterAddress);

        vm.stopBroadcast();
    }
}
