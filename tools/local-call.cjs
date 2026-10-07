// Só para os testes locais: envia UMA chamada ao ledger como a conta indicada (contas destravadas do nó local).
// Uso: node tools/local-call.cjs <ledger> <from> <função> <run> <n>   (função: state | openRefundCase | replay | settleLike1)
const { createWalletClient, createPublicClient, http, keccak256, toHex } = require("viem");
const { hardhat } = require("viem/chains");
const [ledger, from, fn, run, n] = process.argv.slice(2);
const abi = [
  { type: "function", name: "openRefundCase", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "settle", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "usdc", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "getOrder", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
    { name: "state", type: "uint8" }, { name: "merchant", type: "address" }, { name: "settledAt", type: "uint64" }, { name: "amount", type: "uint256" },
    { name: "settlementId", type: "bytes32" }, { name: "receiptDigest", type: "bytes32" }, { name: "paidFrom", type: "address" }] }] },
];
(async () => {
  const transport = http("http://127.0.0.1:8545");
  const pub = createPublicClient({ chain: hardhat, transport });
  const w = createWalletClient({ chain: hardhat, transport, account: from });
  const ref = keccak256(toHex(`demo-${run}-${n}`));
  let hash;
  if (fn === "state") { // só leitura
    const o = await pub.readContract({ address: ledger, abi, functionName: "getOrder", args: [ref] });
    console.log(JSON.stringify({ ref, state: Number(o.state) })); return;
  }
  if (fn === "openRefundCase") hash = await w.writeContract({ address: ledger, abi, functionName: "openRefundCase", args: [ref] });
  else if (fn === "replay") {
    const o = await pub.readContract({ address: ledger, abi, functionName: "getOrder", args: [ref] });
    hash = await w.writeContract({ address: ledger, abi, functionName: "settle", args: [ref, o.settlementId, o.merchant, o.amount, o.receiptDigest] });
  } else if (fn === "settleLike1") { // liquida o pedido n com o mesmo lojista e valor do pedido 1 (cenário de exposição)
    const o1 = await pub.readContract({ address: ledger, abi, functionName: "getOrder", args: [keccak256(toHex(`demo-${run}-1`))] });
    const token = await pub.readContract({ address: ledger, abi, functionName: "usdc" });
    const ah = await w.writeContract({ address: token, abi, functionName: "approve", args: [ledger, o1.amount] });
    await pub.waitForTransactionReceipt({ hash: ah });
    hash = await w.writeContract({ address: ledger, abi, functionName: "settle",
      args: [ref, keccak256(toHex(`stl-${run}-${n}`)), o1.merchant, o1.amount, keccak256(toHex(`rd-${run}-${n}`))] });
  } else throw new Error("função desconhecida " + fn);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error("tx revertida");
  console.log(JSON.stringify({ hash, block: String(r.blockNumber), ref }));
})().catch((e) => { console.error(e.message); process.exit(1); });
