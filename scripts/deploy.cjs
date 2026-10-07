// Deploy do PixSettleLedger. Uso (Codex, item A4 do backlog):
//   ARC_DEPLOYER_KEY=... OPERATOR=0x... TREASURY=0x... npx hardhat run scripts/deploy.cjs --network arcTestnet
// A chave fica só na variável de ambiente; nunca em arquivo, log ou pacote. Na Arc o USDC é sempre o oficial.
const hre = require("hardhat");
const { resolveUsdc, checkToken, checkLedger } = require("./preflight.cjs");

async function main() {
  const operator = process.env.OPERATOR;
  const treasury = process.env.TREASURY;
  if (!operator || !treasury) throw new Error("defina OPERATOR e TREASURY");
  const pub = await hre.viem.getPublicClient();
  const chainId = await pub.getChainId();
  const usdc = resolveUsdc(hre.network.name, chainId, process.env.USDC);
  await checkToken(pub, usdc);
  const { contract: ledger, deploymentTransaction } = await hre.viem.sendDeploymentTransaction("PixSettleLedger", [usdc, operator, treasury, 6]);
  console.log(JSON.stringify({ sent: deploymentTransaction.hash })); // registrar antes de esperar: resultado desconhecido se resolve por este hash
  const receipt = await pub.waitForTransactionReceipt({ hash: deploymentTransaction.hash });
  if (receipt.status !== "success") throw new Error("deploy revertido");
  await checkLedger(pub, ledger, usdc, { operator, treasury });
  const deployBlock = String(receipt.blockNumber); // o painel precisa deste bloco para cobertura completa
  console.log(JSON.stringify({ chainId, ledger: ledger.address, usdc, operator, treasury, deployBlock }, null, 2));
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
