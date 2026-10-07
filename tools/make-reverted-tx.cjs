// Gera, no nó local, uma transação MINERADA e REVERTIDA (para testar a retomada). Imprime o hash.
// Desliga o automine para o nó não recusar o envio na estimativa, envia com gás fixo e minera.
const { createWalletClient, createPublicClient, http, encodeFunctionData, keccak256, toHex } = require("viem");
const { hardhat } = require("viem/chains");
const ledger = process.argv[2];
const from = process.argv[3];
(async () => {
  const transport = http("http://127.0.0.1:8545");
  const pub = createPublicClient({ chain: hardhat, transport });
  const w = createWalletClient({ chain: hardhat, transport, account: from });
  const abi = [{ type: "function", name: "returnExposure", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] }];
  let hash;
  await pub.request({ method: "evm_setAutomine", params: [false] });
  try {
    hash = await w.sendTransaction({ to: ledger, gas: 200000n,
      data: encodeFunctionData({ abi, functionName: "returnExposure", args: [keccak256(toHex("nao-existe"))] }) });
    await pub.request({ method: "evm_mine", params: [] });
  } finally {
    await pub.request({ method: "evm_setAutomine", params: [true] }); // never leave the node without automine
  }
  const r = await pub.getTransactionReceipt({ hash });
  if (r.status !== "reverted") throw new Error("esperava revertida, veio " + r.status);
  console.log(hash);
})().catch((e) => { console.error(e.message); process.exit(1); });
