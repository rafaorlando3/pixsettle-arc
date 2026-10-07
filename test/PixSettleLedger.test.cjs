const { expect } = require("chai");
const hre = require("hardhat");
const { keccak256, toHex, getAddress } = require("viem");

const id = (s) => keccak256(toHex(s));
const USDC = (n) => BigInt(Math.round(n * 1e6)); // interface ERC-20 do USDC na Arc: 6 casas
const State = { None: 0, Settled: 1, RefundOpen: 2, Exposure: 3, Closed: 4 };

async function expectRevert(promise, errorName) {
  let err;
  try { await promise; } catch (e) { err = e; }
  expect(err, `esperava revert ${errorName}`).to.not.equal(undefined);
  expect(String(err.message || err)).to.include(errorName);
}

async function setup() {
  const [owner, operator, treasury, merchant, other] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();
  const usdc = await hre.viem.deployContract("MockUSDC", [6]);
  const ledger = await hre.viem.deployContract("PixSettleLedger", [
    usdc.address, operator.account.address, treasury.account.address, 6,
  ]);
  await usdc.write.mint([treasury.account.address, USDC(1000)]);
  await usdc.write.approve([ledger.address, USDC(1000)], { account: treasury.account });
  await ledger.write.setMerchant([merchant.account.address, true]);
  const asOp = { account: operator.account };
  const bal = (a) => usdc.read.balanceOf([a]);
  return { owner, operator, treasury, merchant, other, pub, usdc, ledger, asOp, bal };
}

const ORDER = id("order-001");
const STL = id("stl_01J9Z0000000000000000000AB");
const RCPT = id("receipt-digest-001");

describe("PixSettleLedger", () => {
  it("le 6 casas do token (USDC ERC-20 na Arc), nunca 18", async () => {
    const { ledger } = await setup();
    expect(await ledger.read.tokenDecimals()).to.equal(6);
  });

  it("liquida: paga o lojista e grava o recibo", async () => {
    const { ledger, merchant, treasury, asOp, bal } = await setup();
    await ledger.write.settle([ORDER, STL, merchant.account.address, USDC(12.5), RCPT], asOp);
    expect(await bal(merchant.account.address)).to.equal(USDC(12.5));
    expect(await bal(treasury.account.address)).to.equal(USDC(987.5));
    const o = await ledger.read.getOrder([ORDER]);
    expect(o.state).to.equal(State.Settled);
    expect(o.receiptDigest).to.equal(RCPT);
    expect(getAddress(o.merchant)).to.equal(getAddress(merchant.account.address));
    expect(await ledger.read.orderOfSettlement([STL])).to.equal(ORDER);
  });

  it("repetir o mesmo settlementId nao paga de novo (idempotente)", async () => {
    const { ledger, merchant, asOp, bal, pub } = await setup();
    await ledger.write.settle([ORDER, STL, merchant.account.address, USDC(10), RCPT], asOp);
    const sim = await ledger.simulate.settle([ORDER, STL, merchant.account.address, USDC(10), RCPT], asOp);
    expect(sim.result).to.equal(false);
    const h = await ledger.write.settle([ORDER, STL, merchant.account.address, USDC(10), RCPT], asOp);
    const r = await pub.waitForTransactionReceipt({ hash: h });
    expect(r.status).to.equal("success");
    expect(await bal(merchant.account.address)).to.equal(USDC(10));
  });

  it("repeticao com dado diferente reverte (ReplayMismatch)", async () => {
    const { ledger, merchant, asOp } = await setup();
    await ledger.write.settle([ORDER, STL, merchant.account.address, USDC(10), RCPT], asOp);
    await expectRevert(ledger.write.settle([ORDER, STL, merchant.account.address, USDC(11), RCPT], asOp), "ReplayMismatch");
    await expectRevert(ledger.write.settle([id("x"), STL, merchant.account.address, USDC(10), RCPT], asOp), "ReplayMismatch");
  });

  it("segunda liquidacao do mesmo pedido com outro settlementId reverte", async () => {
    const { ledger, merchant, asOp } = await setup();
    await ledger.write.settle([ORDER, STL, merchant.account.address, USDC(10), RCPT], asOp);
    await expectRevert(ledger.write.settle([ORDER, id("stl-2"), merchant.account.address, USDC(10), RCPT], asOp), "InvalidState");
  });

  it("caso de devolucao aberto bloqueia a liquidacao; improcedente libera", async () => {
    const { ledger, merchant, asOp, bal } = await setup();
    await ledger.write.openRefundCase([ORDER], asOp);
    await expectRevert(ledger.write.settle([ORDER, STL, merchant.account.address, USDC(10), RCPT], asOp), "InvalidState");
    await ledger.write.closeRefundCase([ORDER, false], asOp);
    await ledger.write.settle([ORDER, STL, merchant.account.address, USDC(10), RCPT], asOp);
    expect(await bal(merchant.account.address)).to.equal(USDC(10));
  });

  it("devolucao confirmada antes de liquidar encerra o pedido sem pagamento", async () => {
    const { ledger, merchant, asOp, bal } = await setup();
    await ledger.write.openRefundCase([ORDER], asOp);
    await ledger.write.closeRefundCase([ORDER, true], asOp);
    expect((await ledger.read.getOrder([ORDER])).state).to.equal(State.Closed);
    await expectRevert(ledger.write.settle([ORDER, STL, merchant.account.address, USDC(10), RCPT], asOp), "InvalidState");
    expect(await bal(merchant.account.address)).to.equal(0n);
  });

  it("devolucao depois de liquidar vira exposicao; lojista devolve a tesouraria", async () => {
    const { ledger, usdc, merchant, treasury, asOp, bal } = await setup();
    await ledger.write.settle([ORDER, STL, merchant.account.address, USDC(10), RCPT], asOp);
    await ledger.write.openRefundCase([ORDER], asOp);
    expect((await ledger.read.getOrder([ORDER])).state).to.equal(State.Exposure);
    await usdc.write.approve([ledger.address, USDC(10)], { account: merchant.account });
    await ledger.write.returnExposure([ORDER], { account: merchant.account });
    expect(await bal(merchant.account.address)).to.equal(0n);
    expect(await bal(treasury.account.address)).to.equal(USDC(1000));
    expect((await ledger.read.getOrder([ORDER])).state).to.equal(State.Closed);
  });

  it("so o lojista do pedido devolve a exposicao", async () => {
    const { ledger, merchant, other, asOp } = await setup();
    await ledger.write.settle([ORDER, STL, merchant.account.address, USDC(10), RCPT], asOp);
    await ledger.write.openRefundCase([ORDER], asOp);
    await expectRevert(ledger.write.returnExposure([ORDER], { account: other.account }), "NotOrderMerchant");
  });

  it("exposicao improcedente volta a Settled sem mover dinheiro", async () => {
    const { ledger, merchant, asOp, bal } = await setup();
    await ledger.write.settle([ORDER, STL, merchant.account.address, USDC(10), RCPT], asOp);
    await ledger.write.openRefundCase([ORDER], asOp);
    await ledger.write.dismissExposure([ORDER], asOp);
    expect((await ledger.read.getOrder([ORDER])).state).to.equal(State.Settled);
    expect(await bal(merchant.account.address)).to.equal(USDC(10));
  });

  it("controle de acesso: so operador liquida e abre caso; so dono cadastra lojista", async () => {
    const { ledger, merchant, other } = await setup();
    const asOther = { account: other.account };
    await expectRevert(ledger.write.settle([ORDER, STL, merchant.account.address, USDC(10), RCPT], asOther), "NotOperator");
    await expectRevert(ledger.write.openRefundCase([ORDER], asOther), "NotOperator");
    await expectRevert(ledger.write.setMerchant([other.account.address, true], asOther), "NotOwner");
  });

  it("lojista nao cadastrado e valores zero revertem", async () => {
    const { ledger, merchant, other, asOp } = await setup();
    await expectRevert(ledger.write.settle([ORDER, STL, other.account.address, USDC(10), RCPT], asOp), "UnknownMerchant");
    await expectRevert(ledger.write.settle([ORDER, STL, merchant.account.address, 0n, RCPT], asOp), "ZeroValue");
    await expectRevert(ledger.write.settle([ORDER, STL, merchant.account.address, USDC(1), `0x${"0".repeat(64)}`], asOp), "ZeroValue");
  });

  it("token que devolve false reverte a liquidacao inteira (sem estado parcial)", async () => {
    const { ledger, usdc, merchant, asOp } = await setup();
    await usdc.write.setFailMode([true]);
    await expectRevert(ledger.write.settle([ORDER, STL, merchant.account.address, USDC(10), RCPT], asOp), "TransferFailed");
    expect((await ledger.read.getOrder([ORDER])).state).to.equal(State.None);
    expect(await ledger.read.orderOfSettlement([STL])).to.equal(`0x${"0".repeat(64)}`);
  });

  it("emite Settled com os campos do recibo", async () => {
    const { ledger, merchant, asOp, pub } = await setup();
    const h = await ledger.write.settle([ORDER, STL, merchant.account.address, USDC(3), RCPT], asOp);
    await pub.waitForTransactionReceipt({ hash: h });
    const ev = await ledger.getEvents.Settled();
    expect(ev).to.have.length(1);
    expect(ev[0].args.orderRef).to.equal(ORDER);
    expect(ev[0].args.settlementId).to.equal(STL);
    expect(ev[0].args.amount).to.equal(USDC(3));
    expect(ev[0].args.receiptDigest).to.equal(RCPT);
  });

  it("construtor recusa conta sem codigo no lugar do token", async () => {
    const [, operator, treasury] = await hre.viem.getWalletClients();
    let err;
    try {
      await hre.viem.deployContract("PixSettleLedger", [operator.account.address, operator.account.address, treasury.account.address, 6]);
    } catch (e) { err = e; }
    expect(err, "deploy com EOA no lugar do token deveria reverter").to.not.equal(undefined);
  });

  it("construtor recusa token de 18 casas quando espera 6 (confusao com o gas nativo)", async () => {
    const [, operator, treasury] = await hre.viem.getWalletClients();
    const t18 = await hre.viem.deployContract("MockUSDC", [18]);
    await expectRevert(
      hre.viem.deployContract("PixSettleLedger", [t18.address, operator.account.address, treasury.account.address, 6]),
      "WrongDecimals",
    );
  });
});

describe("PixSettleLedger v2 (revisão X-0311)", () => {
  it("devolução vai para a tesouraria que pagou, mesmo após troca de tesouraria", async () => {
    const { ledger, usdc, merchant, treasury, other, asOp, bal } = await setup();
    await ledger.write.settle([ORDER, STL, merchant.account.address, USDC(12.5), RCPT], asOp);
    expect(getAddress((await ledger.read.getOrder([ORDER])).paidFrom)).to.equal(getAddress(treasury.account.address));
    await ledger.write.setTreasury([other.account.address]);
    await ledger.write.openRefundCase([ORDER], asOp);
    await usdc.write.approve([ledger.address, USDC(12.5)], { account: merchant.account });
    const before = await bal(other.account.address);
    await ledger.write.returnExposure([ORDER], { account: merchant.account });
    expect(await bal(treasury.account.address)).to.equal(USDC(1000));
    expect(await bal(other.account.address)).to.equal(before);
    const ev = await ledger.getEvents.ExposureReturned();
    expect(getAddress(ev[0].args.paidFrom)).to.equal(getAddress(treasury.account.address));
  });

  it("pedido liquidado depois da troca usa a tesouraria nova", async () => {
    const { ledger, usdc, merchant, other, asOp } = await setup();
    await usdc.write.mint([other.account.address, USDC(10)]);
    await usdc.write.approve([ledger.address, USDC(10)], { account: other.account });
    await ledger.write.setTreasury([other.account.address]);
    await ledger.write.settle([ORDER, STL, merchant.account.address, USDC(1), RCPT], asOp);
    expect(getAddress((await ledger.read.getOrder([ORDER])).paidFrom)).to.equal(getAddress(other.account.address));
  });

  it("token falso de 6 casas passa no construtor: decimals não autentica (por isso o preflight)", async () => {
    const [, operator, treasury] = await hre.viem.getWalletClients();
    const fake = await hre.viem.deployContract("MockUSDC", [6]);
    const l = await hre.viem.deployContract("PixSettleLedger", [fake.address, operator.account.address, treasury.account.address, 6]);
    expect(getAddress(await l.read.usdc())).to.equal(getAddress(fake.address));
  });
});
