const { expect } = require("chai");
const hre = require("hardhat");
const { keccak256, toHex } = require("viem");
const { resolveUsdc, checkToken, checkLedger, ARC_USDC } = require("../scripts/preflight.cjs");
const { buildReceipt, digest, verify, canon } = require("../scripts/receipt.cjs");

async function throwsWith(p, txt) {
  let err; try { await p; } catch (e) { err = e; }
  expect(err, "esperava erro " + txt).to.not.equal(undefined);
  expect(String(err.message)).to.include(txt);
}

describe("preflight", () => {
  it("Arc: USDC diferente do oficial, chainId trocado ou rede sem USDC de teste abortam", async () => {
    await throwsWith(Promise.resolve().then(() => resolveUsdc("arcTestnet", 5042002, "0x" + "22".repeat(20))), "proibido");
    await throwsWith(Promise.resolve().then(() => resolveUsdc("arcMainnet", 5042002)), "inesperado");
    await throwsWith(Promise.resolve().then(() => resolveUsdc("hardhat", 31337)), "defina USDC");
    expect(resolveUsdc("arcMainnet", 5042)).to.equal(ARC_USDC);
  });
  it("token de 18 casas e conta sem código abortam", async () => {
    const pub = await hre.viem.getPublicClient();
    const t18 = await hre.viem.deployContract("MockUSDC", [18]);
    await throwsWith(checkToken(pub, t18.address), "18 casas");
    const [, eoa] = await hre.viem.getWalletClients();
    await throwsWith(checkToken(pub, eoa.account.address), "sem código");
  });
  it("ledger com outro token, operador ou tesouraria diferente, ou saldo curto aborta", async () => {
    const pub = await hre.viem.getPublicClient();
    const [ops, other] = await hre.viem.getWalletClients();
    const a = await hre.viem.deployContract("MockUSDC", [6]);
    const b = await hre.viem.deployContract("MockUSDC", [6]);
    const l = await hre.viem.deployContract("PixSettleLedger", [a.address, ops.account.address, ops.account.address, 6]);
    await throwsWith(checkLedger(pub, l, b.address, {}), "ledger.usdc()");
    await throwsWith(checkLedger(pub, l, a.address, { operator: other.account.address }), "operador");
    await throwsWith(checkLedger(pub, l, a.address, { operator: ops.account.address, treasury: ops.account.address, needTreasuryBalance: 1n }), "saldo");
  });
});

describe("recibo canônico", () => {
  const base = { chainId: 5042002, ledger: "0x" + "AB".repeat(20), orderRef: keccak256(toHex("o")), settlementId: keccak256(toHex("s")),
    merchant: "0x" + "CD".repeat(20), amount: 100000n, pixE2eId: "E-SIMULADO-1" };
  it("canônico ordena chaves e o digest é sha256 estável", () => {
    const r = buildReceipt(base);
    expect(canon(r).startsWith('{"amount":"100000","chainId":"5042002","currency":"USDC"')).to.equal(true);
    expect(digest(r)).to.match(/^0x[0-9a-f]{64}$/);
    expect(digest(buildReceipt(base))).to.equal(digest(r));
  });
  it("confere com o evento e quebra ao mudar valor, destinatário, moeda ou orderRef", () => {
    const r = buildReceipt(base);
    const ev = { receiptDigest: digest(r), orderRef: base.orderRef, settlementId: base.settlementId, merchant: base.merchant,
      amount: 100000n, ledger: base.ledger, chainId: 5042002 };
    expect(verify(r, ev)).to.deep.equal([]);
    for (const [k, v] of [["amount", "100001"], ["merchant", "0x" + "ee".repeat(20)], ["currency", "USDT"], ["orderRef", keccak256(toHex("x"))]]) {
      const t = { ...r, [k]: v };
      expect(verify(t, ev).length, k).to.be.greaterThan(0);
    }
  });
});
