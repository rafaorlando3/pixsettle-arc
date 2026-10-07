require("@nomicfoundation/hardhat-viem");
/** Arc: chain 5042 (mainnet) e 5042002 (testnet), docs.arc.io. Chave só por variável de ambiente. */
const accounts = process.env.ARC_DEPLOYER_KEY ? [process.env.ARC_DEPLOYER_KEY] : [];
module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" } },
  networks: {
    arcTestnet: { url: process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.io", chainId: 5042002, accounts },
    arcMainnet: { url: process.env.ARC_MAINNET_RPC || "https://rpc.mainnet.arc.io", chainId: 5042, accounts },
  },
};
module.exports.networks.localhost = { url: "http://127.0.0.1:8545" };
