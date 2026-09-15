require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    // Rede local (npx hardhat node) — para desenvolvimento e testes
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    // Testnet pública Sepolia — para o deploy de validação
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
  gasReporter: {
    enabled: true,
    currency: "USD",
  },
};

// Fallback para ambientes sem acesso a binaries.soliditylang.org:
// usa o compilador solc-js instalado via npm. Ative com SOLC_LOCAL=1.
if (process.env.SOLC_LOCAL === "1") {
  const { subtask } = require("hardhat/config");
  const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
    if (args.solcVersion === "0.8.28") {
      return {
        compilerPath: require.resolve("solc/soljson.js"),
        isSolcJs: true,
        version: args.solcVersion,
        longVersion: "0.8.28+local",
      };
    }
    return runSuper(args);
  });
}
