import { defineConfig } from '@wagmi/cli';
import { foundry } from '@wagmi/cli/plugins';

// ABIs of the Cauce contracts, generated from the Foundry project instead of copied by hand.
// Run `pnpm generate:abis` after changing contracts/src; CI fails if the output drifts.
export default defineConfig({
  out: 'src/abis/generated.ts',
  plugins: [
    foundry({
      project: '../../contracts',
      include: ['CauceVault.sol/CauceVault.json', 'CauceRelay.sol/CauceRelay.json'],
    }),
  ],
});
