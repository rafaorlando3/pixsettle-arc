// Preflight obrigatório antes de qualquer aprovação ou transferência (deploy e demo).
// Na Arc: chainId permitido, USDC = endereço oficial (sem override), código no token e no ledger,
// decimals 6, ledger.usdc() igual ao token, papéis e saldos. Qualquer falha lança e nada é enviado.
const ARC_USDC = "0x3600000000000000000000000000000000000000"; // docs.arc.io, contract-addresses, lido em 01/10/2026
const ARC_CHAINS = { 5042: "arcMainnet", 5042002: "arcTestnet" };
const ERC20_READ = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function resolveUsdc(networkName, chainId, envUsdc) {
  const isArc = networkName in { arcMainnet: 1, arcTestnet: 1 } || chainId in ARC_CHAINS;
  if (isArc) {
    if (!(chainId in ARC_CHAINS) || ARC_CHAINS[chainId] !== networkName) throw new Error(`preflight: rede ${networkName} com chainId ${chainId} inesperado`);
    if (envUsdc && !eq(envUsdc, ARC_USDC)) throw new Error("preflight: USDC diferente do oficial é proibido na Arc");
    return ARC_USDC;
  }
  if (!envUsdc) throw new Error("preflight: fora da Arc, defina USDC (token de teste identificado)");
  return envUsdc;
}

async function checkToken(pub, usdc) {
  const code = await pub.getCode({ address: usdc });
  if (!code || code === "0x") throw new Error("preflight: token sem código");
  const dec = await pub.readContract({ address: usdc, abi: ERC20_READ, functionName: "decimals" });
  if (Number(dec) !== 6) throw new Error(`preflight: token com ${dec} casas, esperado 6`);
}

async function checkLedger(pub, ledger, usdc, { operator, treasury, needTreasuryBalance }) {
  const code = await pub.getCode({ address: ledger.address });
  if (!code || code === "0x") throw new Error("preflight: ledger sem código");
  if (!eq(await ledger.read.usdc(), usdc)) throw new Error("preflight: ledger.usdc() diverge do token");
  if (operator && !eq(await ledger.read.operator(), operator)) throw new Error("preflight: operador diverge");
  if (treasury && !eq(await ledger.read.treasury(), treasury)) throw new Error("preflight: tesouraria diverge");
  if (needTreasuryBalance !== undefined) {
    const b = await pub.readContract({ address: usdc, abi: ERC20_READ, functionName: "balanceOf", args: [treasury] });
    if (b < needTreasuryBalance) throw new Error(`preflight: saldo da tesouraria ${b} < ${needTreasuryBalance}`);
  }
}

module.exports = { ARC_USDC, ARC_CHAINS, resolveUsdc, checkToken, checkLedger };
