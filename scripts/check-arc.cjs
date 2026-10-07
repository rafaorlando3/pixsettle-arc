// Confere sem chave e sem gastar gás: simula o deploy por eth_call nas RPCs públicas da Arc.
// Prova que o bytecode roda na Arc e que o endereço USDC 0x3600... responde 6 casas. Rodar depois de "npx hardhat compile".
const { encodeDeployData, createPublicClient, http, toFunctionSelector } = require("viem");
const WRONG_DECIMALS = toFunctionSelector("WrongDecimals()");
const art = require("../artifacts/contracts/PixSettleLedger.sol/PixSettleLedger.json");
let failures = 0;
(async () => {
  for (const [name, url] of [["testnet","https://rpc.testnet.arc.io"],["mainnet","https://rpc.mainnet.arc.io"]]) {
    const pub = createPublicClient({ transport: http(url) });
    const dummy = "0x000000000000000000000000000000000000dEaD";
    const ok = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: ["0x3600000000000000000000000000000000000000", dummy, dummy, 6] });
    const bad = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: ["0x3600000000000000000000000000000000000000", dummy, dummy, 18] });
    try { const r = await pub.call({ account: dummy, data: ok }); console.log(name, "deploy simulado com 6 casas: ok, runtime de", (r.data.length-2)/2, "bytes (difere do artefato só pelo imutável usdc)"); }
    catch (e) { failures++; console.log(name, "deploy 6 falhou:", e.shortMessage); }
    try { const g = await pub.estimateGas({ account: dummy, data: ok }); console.log(name, "gas estimado", g); } catch (e) { failures++; console.log(name, "estimateGas:", e.shortMessage); }
    try { await pub.call({ account: dummy, data: bad }); failures++; console.log(name, "deploy 18 NAO reverteu (ruim)"); }
    catch (e) {
      const raw = JSON.stringify(e, (k, v) => (typeof v === "bigint" ? String(v) : v));
      const okRevert = raw.includes(WRONG_DECIMALS.slice(2));
      if (!okRevert) failures++;
      console.log(name, "deploy com 18 casas reverte:", okRevert ? "WrongDecimals (esperado)" : "outro motivo (conferir)");
    }
  }
  if (failures) { console.error(`check-arc: ${failures} verificação(ões) falharam`); process.exit(1); }
  console.log("check-arc: tudo conferiu");
})().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
