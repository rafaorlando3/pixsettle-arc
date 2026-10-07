// Fluxo de demonstração com os quatro casos do PixSettle (Pix simulado fora da cadeia):
//   1) pedido pago e liquidado; 2) repetição do mesmo settlementId (não paga de novo);
//   3) devolução aberta antes de liquidar (bloqueia) e confirmada; 4) devolução depois de liquidar
//   (exposição) e devolução do lojista à tesouraria que pagou.
// v2: manifesto estável por execução (DEMO_MANIFEST). Cada tx é registrada ANTES de esperar o recibo;
// retomar com o mesmo manifesto pula o que já confirmou e para em resultado desconhecido ou revertido,
// sem reenviar às cegas. Preflight completo antes de qualquer aprovação. Teto de valor (MAX_TOTAL_UNITS).
// v3: trava de processo (um manifesto, um processo), manifesto validado (v, run, amountUnits, RUN_ID),
// bloco do recibo guardado também na reconciliação, e na Arc um RUN_ID já usado no ledger é recusado.
// v4: um registro "success" só é aceito com prova na cadeia: hash e bloco no formato certo, recibo success
// no mesmo bloco e transação com remetente, destino e calldata exatamente do passo. Registro incompleto ou
// divergente para a execução para conciliação, sem reenviar. No fim exige os estados 1/4/4 e os eventos de
// cada passo na própria tx do passo; um estado diferente é diagnosticado, nunca "corrigido" com tx nova.
// v5: reconciliação SEM envios antes do primeiro passo ausente. O plano inteiro (remetente, destino, calldata,
// eventos e estados esperados depois de cada passo) é montado antes; todos os registros existentes precisam formar
// um prefixo do plano, sem lacuna nem ordem trocada, cada um com recibo, tx e os eventos do PRÓPRIO passo
// (passos 1 e 2 têm a mesma calldata e só os eventos os distinguem); os estados atuais precisam ser os do prefixo.
// Só então os passos ausentes são enviados, cada um com conferência de estado logo antes e prova logo depois.
// Isso não torna a execução atômica: mudança externa depois da leitura continua possível e é pega nas verificações finais.
// MAX_TOTAL_UNITS limita só o valor das duas liquidações (0,20 USDC); não inclui gás, nem o retorno da exposição
// pelo lojista, nem as aprovações. Antes de uma execução real: estimar gás e saldo dos dois signers.
// Local:  npx hardhat run scripts/demo-flow.cjs --network localhost   (token de teste, manifesto local)
// Arc:    DEMO_MANIFEST=./demo-arc.json RUN_ID=arc-001 LEDGER=0x... npx hardhat run scripts/demo-flow.cjs --network arcTestnet
//         com ARC_DEPLOYER_KEY (dono, operador e tesouraria) e MERCHANT_KEY nas variáveis de ambiente.
const fs = require("node:fs");
const hre = require("hardhat");
const { keccak256, toHex, parseUnits, createWalletClient, http, encodeFunctionData, parseEventLogs } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { resolveUsdc, checkToken, checkLedger } = require("./preflight.cjs");
const { buildReceipt, digest, verify } = require("./receipt.cjs");

const id = (s) => keccak256(toHex(s));
const ERC20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "event", name: "Approval", inputs: [{ name: "owner", type: "address", indexed: true }, { name: "spender", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] },
];
const AMOUNT = parseUnits("0.10", 6); // 0,10 USDC por pedido liquidado
const SETTLED_ORDERS = 2n; // pedidos 1 e 4
const MAX_TOTAL_UNITS = BigInt(process.env.MAX_TOTAL_UNITS || "200000"); // 0,20 USDC

async function main() {
  const pub = await hre.viem.getPublicClient();
  const chainId = await pub.getChainId();
  const local = ["hardhat", "localhost"].includes(hre.network.name);
  if (AMOUNT * SETTLED_ORDERS > MAX_TOTAL_UNITS) throw new Error("valor acima do teto MAX_TOTAL_UNITS");
  const [ops] = await hre.viem.getWalletClients();
  const path = process.env.DEMO_MANIFEST || (local ? "demo-manifest.local.json" : null);
  if (!path) throw new Error("defina DEMO_MANIFEST");
  // Um processo por manifesto: a trava é criada de forma exclusiva antes de qualquer leitura ou envio.
  const lock = path + ".lock";
  try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); }
  catch (e) { throw new Error(`manifesto em uso por outro processo (${lock}); confira antes de apagar a trava`); }
  process.on("exit", () => { try { if (fs.readFileSync(lock, "utf8") === String(process.pid)) fs.unlinkSync(lock); } catch {} });
  let m = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : null;
  const save = () => { fs.writeFileSync(path + ".tmp", JSON.stringify(m, null, 2)); fs.renameSync(path + ".tmp", path); };
  if (m) {
    if (m.v !== 1) throw new Error("manifesto: versão desconhecida");
    if (typeof m.run !== "string" || !/^[A-Za-z0-9._:-]{1,40}$/.test(m.run)) throw new Error("manifesto: run inválido");
    if (m.amountUnits !== String(AMOUNT)) throw new Error(`manifesto: amountUnits ${m.amountUnits} diferente de ${AMOUNT}`);
    if (process.env.RUN_ID && process.env.RUN_ID !== m.run) throw new Error(`manifesto é da execução ${m.run}, não de RUN_ID=${process.env.RUN_ID}`);
    if (!m.steps || typeof m.steps !== "object" || !Array.isArray(m.steps_order)) throw new Error("manifesto: steps ausentes");
  }

  let merchant, usdcAddr, ledger;
  if (local) {
    const wallets = await hre.viem.getWalletClients();
    merchant = wallets[1];
    if (m) {
      usdcAddr = m.usdc; ledger = await hre.viem.getContractAt("PixSettleLedger", m.ledger);
    } else {
      const usdc = await hre.viem.deployContract("MockUSDC", [6]);
      await usdc.write.mint([ops.account.address, parseUnits("100", 6)]);
      usdcAddr = usdc.address;
      ledger = await hre.viem.deployContract("PixSettleLedger", [usdcAddr, ops.account.address, ops.account.address, 6]);
    }
  } else {
    if (!process.env.LEDGER || !process.env.MERCHANT_KEY) throw new Error("defina LEDGER e MERCHANT_KEY");
    usdcAddr = resolveUsdc(hre.network.name, chainId, process.env.USDC);
    ledger = await hre.viem.getContractAt("PixSettleLedger", process.env.LEDGER);
    const account = privateKeyToAccount(process.env.MERCHANT_KEY);
    merchant = createWalletClient({ account, chain: pub.chain, transport: http(hre.network.config.url) });
  }

  if (!m) {
    const run = process.env.RUN_ID || (local ? `local-${Date.now()}` : null);
    if (!run) throw new Error("defina RUN_ID para um manifesto novo");
    if (!/^[A-Za-z0-9._:-]{1,40}$/.test(run)) throw new Error("RUN_ID: use [A-Za-z0-9._:-], até 40");
    // Manifesto perdido não se resolve com o mesmo RUN_ID às cegas: se o ledger já conhece pedidos dessa
    // execução, é preciso reconciliar pela cadeia antes de seguir.
    for (const n of [1, 3, 4]) {
      const st = Number((await ledger.read.getOrder([id(`demo-${run}-${n}`)])).state);
      if (st !== 0) throw new Error(`RUN_ID ${run} já tem pedido ${n} no ledger (estado ${st}); reconcilie pela cadeia, sem manifesto novo`);
    }
    m = { v: 1, run, chainId, ledger: ledger.address, usdc: usdcAddr, merchant: merchant.account.address,
          amountUnits: String(AMOUNT), steps: {}, steps_order: [], receipts: {} };
    save();
  }
  for (const [k, v] of [["chainId", chainId], ["ledger", ledger.address], ["usdc", usdcAddr], ["merchant", merchant.account.address]]) {
    if (String(m[k]).toLowerCase() !== String(v).toLowerCase()) throw new Error(`manifesto diverge em ${k}`);
  }

  // Preflight antes de qualquer envio (na Arc e também no local, com o token de teste).
  await checkToken(pub, usdcAddr);
  await checkLedger(pub, ledger, usdcAddr, { operator: ops.account.address, treasury: ops.account.address,
    needTreasuryBalance: m.steps["1 liquidar pedido pago"]?.status === "success" ? undefined : AMOUNT * SETTLED_ORDERS });

  const HASH = /^0x[0-9a-fA-F]{64}$/;
  const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  const lc = (x) => String(x).toLowerCase();
  const L = ledger.address, LA = ledger.abi;
  const run = m.run;
  const mk = (n, pix) => {
    const orderRef = id(`demo-${run}-${n}`), settlementId = id(`stl-${run}-${n}`);
    const rc = buildReceipt({ chainId, ledger: ledger.address, orderRef, settlementId, merchant: merchant.account.address,
      amount: AMOUNT, pixE2eId: pix });
    m.receipts[n] = rc; save();
    return { orderRef, settlementId, rd: digest(rc) };
  };
  const o1 = mk(1, `E-SIMULADO-${run}-1`);
  const o4 = mk(4, `E-SIMULADO-${run}-4`);
  const o3 = id(`demo-${run}-3`);
  const MER = merchant.account.address;

  // v5: o plano inteiro é descrito antes de qualquer envio. Cada passo diz quem envia, para onde, a chamada,
  // os eventos que o definem (na própria tx) e os estados esperados depois dele (0 None, 1 Settled,
  // 2 RefundOpen, 3 Exposure, 4 Closed). A mesma descrição gera o envio e a prova.
  const call = (wallet, to, abi, functionName, args) => ({
    from: wallet.account.address, to, data: encodeFunctionData({ abi, functionName, args }),
    send: () => wallet.writeContract({ address: to, abi, functionName, args }),
  });
  const ev = (address, abi, name, ok) => ({ address, abi, name, ok });
  const approvalEv = (owner, value) => ev(usdcAddr, ERC20, "Approval", (a) => same(a.owner, owner) && same(a.spender, L) && a.value === value);
  const settle1 = [o1.orderRef, o1.settlementId, MER, AMOUNT, o1.rd];
  const plan = [];
  const add = (label, c, events, after, forbid = []) => plan.push({ label, ...c, events, after, forbid });
  const S0 = { pedido1: 0, pedido3: 0, pedido4: 0 };
  add("approve tesouraria", call(ops, usdcAddr, ERC20, "approve", [L, AMOUNT * SETTLED_ORDERS]),
    [approvalEv(ops.account.address, AMOUNT * SETTLED_ORDERS)], S0);
  // O cadastro do lojista só entra no plano se já foi registrado no manifesto ou se o lojista ainda não está cadastrado.
  if (m.steps["cadastrar lojista"] || !(await ledger.read.merchants([MER]))) {
    add("cadastrar lojista", call(ops, L, LA, "setMerchant", [MER, true]),
      [ev(L, LA, "MerchantSet", (a) => same(a.merchant, MER) && a.allowed === true)], S0);
  }
  add("1 liquidar pedido pago", call(ops, L, LA, "settle", settle1),
    [ev(L, LA, "Settled", (a) => same(a.orderRef, o1.orderRef) && a.amount === AMOUNT)], { ...S0, pedido1: 1 });
  add("2 repetir mesmo settlementId (sem novo pagamento)", call(ops, L, LA, "settle", settle1),
    [ev(L, LA, "SettlementReplayed", (a) => same(a.orderRef, o1.orderRef) && same(a.settlementId, o1.settlementId))],
    { ...S0, pedido1: 1 }, ["Settled"]);
  add("3a abrir devolução antes de liquidar", call(ops, L, LA, "openRefundCase", [o3]),
    [ev(L, LA, "RefundCaseOpened", (a) => same(a.orderRef, o3) && a.afterSettlement === false)], { pedido1: 1, pedido3: 2, pedido4: 0 });
  add("3b devolução confirmada, pedido encerrado sem pagamento", call(ops, L, LA, "closeRefundCase", [o3, true]),
    [ev(L, LA, "RefundCaseClosed", (a) => same(a.orderRef, o3) && a.refunded === true)], { pedido1: 1, pedido3: 4, pedido4: 0 });
  add("4a liquidar", call(ops, L, LA, "settle", [o4.orderRef, o4.settlementId, MER, AMOUNT, o4.rd]),
    [ev(L, LA, "Settled", (a) => same(a.orderRef, o4.orderRef) && a.amount === AMOUNT)], { pedido1: 1, pedido3: 4, pedido4: 1 });
  add("4b devolução depois de liquidar (exposição)", call(ops, L, LA, "openRefundCase", [o4.orderRef]),
    [ev(L, LA, "RefundCaseOpened", (a) => same(a.orderRef, o4.orderRef) && a.afterSettlement === true)], { pedido1: 1, pedido3: 4, pedido4: 3 });
  add("4c lojista aprova a devolução", call(merchant, usdcAddr, ERC20, "approve", [L, AMOUNT]),
    [approvalEv(MER, AMOUNT)], { pedido1: 1, pedido3: 4, pedido4: 3 });
  add("4d lojista devolve à tesouraria que pagou", call(merchant, L, LA, "returnExposure", [o4.orderRef]),
    [ev(L, LA, "ExposureReturned", (a) => same(a.orderRef, o4.orderRef) && a.amount === AMOUNT && same(a.merchant, MER)),
     ev(L, LA, "RefundCaseClosed", (a) => same(a.orderRef, o4.orderRef) && a.refunded === true)], { pedido1: 1, pedido3: 4, pedido4: 4 });
  const byLabel = Object.fromEntries(plan.map((p) => [p.label, p]));

  const readStates = async () => {
    const st = {};
    for (const [k, o] of Object.entries({ pedido1: o1.orderRef, pedido3: o3, pedido4: o4.orderRef })) st[k] = Number((await ledger.read.getOrder([o])).state);
    return st;
  };
  const checkStates = async (want, when) => {
    const st = await readStates();
    const d = Object.keys(want).filter((k) => st[k] !== want[k]);
    if (d.length) throw new Error(`${when}: ${d.map((k) => `${k}=${st[k]} (esperado ${want[k]})`).join(", ")}; conciliar pela cadeia, sem novas transações`);
    return st;
  };

  // Prova completa de um passo já na cadeia: recibo success no bloco registrado, tx exatamente do passo
  // (remetente, destino, calldata) e os eventos do passo na própria tx. Calldata igual não basta: os passos 1 e 2
  // fazem a mesma chamada e só os eventos os distinguem.
  const prove = async (p, s) => {
    const r = await pub.getTransactionReceipt({ hash: s.hash }).catch(() => null);
    if (!r) throw new Error(`"${p.label}": registro success sem recibo na cadeia (tx ${s.hash}); conciliar, sem reenviar`);
    if (r.status !== "success") throw new Error(`"${p.label}": registro success, mas a tx ${s.hash} está revertida na cadeia; conciliar, sem reenviar`);
    if (String(r.blockNumber) !== String(s.block)) throw new Error(`"${p.label}": registro success com bloco ${s.block}, cadeia diz ${r.blockNumber}; conciliar, sem reenviar`);
    const tx = await pub.getTransaction({ hash: s.hash }).catch(() => null);
    if (!tx) throw new Error(`"${p.label}": tx ${s.hash} não encontrada; conciliar pela cadeia, sem reenviar`);
    const bad = [["remetente", tx.from, p.from], ["destino", tx.to, p.to], ["calldata", tx.input, p.data]]
      .filter(([, got, want]) => !same(got, want)).map(([k]) => k);
    if (bad.length) throw new Error(`"${p.label}": tx ${s.hash} não corresponde ao passo (${bad.join(", ")}); conciliar, sem reenviar`);
    const out = [];
    for (const e of p.events) {
      const evs = parseEventLogs({ abi: e.abi, logs: r.logs.filter((l) => same(l.address, e.address)) }).filter((x) => x.eventName === e.name);
      if (!evs.some((x) => e.ok(x.args))) throw new Error(`"${p.label}": tx ${s.hash} sem o evento ${e.name} esperado do passo; conciliar, sem reenviar`);
      out.push({ step: p.label, event: e.name, tx: s.hash });
    }
    for (const name of p.forbid) {
      const evs = parseEventLogs({ abi: LA, logs: r.logs.filter((l) => same(l.address, L)) });
      if (evs.some((x) => x.eventName === name)) throw new Error(`"${p.label}": tx ${s.hash} tem o evento proibido ${name} (pagou de novo); conciliar, sem reenviar`);
    }
    return { block: r.blockNumber, proofs: out };
  };

  // ---------- Fase 1: reconciliação, SEM envios ----------
  // Tudo o que está registrado é validado (estrutura, ordem, lacunas, provas e eventos de cada passo) e os estados
  // atuais têm de ser os do prefixo confirmado ANTES do primeiro envio. Qualquer falha para aqui, sem tx nova.
  const order = m.steps_order;
  const keys = Object.keys(m.steps);
  if (new Set(order).size !== order.length) throw new Error("manifesto: passo repetido em steps_order; conciliar, sem reenviar");
  for (const k of keys) if (!order.includes(k)) throw new Error(`manifesto: "${k}" em steps e fora de steps_order; conciliar, sem reenviar`);
  for (const k of order) {
    if (!(k in m.steps)) throw new Error(`manifesto: "${k}" em steps_order sem registro; conciliar, sem reenviar`);
    if (!byLabel[k]) throw new Error(`manifesto: passo desconhecido "${k}"; conciliar, sem reenviar`);
  }
  // Os registros têm de ser exatamente um prefixo do plano, na mesma ordem: lacuna ou registro fora de ordem
  // significa que algo posterior já foi tentado; nada é preenchido antes de conciliar.
  for (let i = 0; i < order.length; i++) {
    if (order[i] !== plan[i].label) {
      const miss = plan.slice(0, order.length).map((p) => p.label).filter((l) => !(l in m.steps));
      throw new Error(miss.length
        ? `manifesto com lacuna: "${miss[0]}" ausente antes de registro posterior ("${order[i]}"); conciliar, sem reenviar`
        : `manifesto fora de ordem: "${order[i]}" na posição de "${plan[i].label}"; conciliar, sem reenviar`);
    }
  }
  const proofs = [];
  const seen = new Map();
  let lastBlock = -1n;
  for (let i = 0; i < order.length; i++) {
    const p = plan[i], s = m.steps[p.label];
    const last = i === order.length - 1;
    if (s.status === "success") {
      if (!HASH.test(String(s.hash)) || !/^[0-9]+$/.test(String(s.block)))
        throw new Error(`"${p.label}": registro success sem hash ou bloco; conciliar pela cadeia, sem reenviar`);
    } else if (s.status === "sending" && last) {
      // Só o último registro pode estar em envio: resolve pelo recibo (leitura), sem reenviar.
      if (!s.hash) throw new Error(`"${p.label}": envio sem hash registrado; resultado desconhecido, confira a conta antes de seguir`);
      if (!HASH.test(String(s.hash))) throw new Error(`"${p.label}": hash registrado malformado; conciliar, sem reenviar`);
      const r = await pub.getTransactionReceipt({ hash: s.hash }).catch(() => null);
      if (!r) throw new Error(`"${p.label}": tx ${s.hash} sem recibo; resolva antes de reenviar`);
      s.status = r.status; s.block = String(r.blockNumber); save();
      if (r.status !== "success") throw new Error(`"${p.label}": tx ${s.hash} revertida`);
    } else {
      throw new Error(`"${p.label}": registro ${JSON.stringify(s.status)} ${last ? "sem prova" : "antes de outros registros"}; conciliar, sem reenviar`);
    }
    const pr = await prove(p, s);
    if (seen.has(lc(s.hash))) throw new Error(`"${p.label}": tx ${s.hash} já é a prova de "${seen.get(lc(s.hash))}"; conciliar, sem reenviar`);
    seen.set(lc(s.hash), p.label);
    if (pr.block < lastBlock) throw new Error(`"${p.label}": bloco ${pr.block} anterior ao do passo anterior; conciliar, sem reenviar`);
    lastBlock = pr.block;
    proofs.push(...pr.proofs);
  }
  const prefixState = order.length ? plan[order.length - 1].after : S0;
  await checkStates(prefixState, `estado atual divergente do prefixo confirmado (${order.length}/${plan.length} passos)`);

  // ---------- Fase 2: completar os passos ausentes, com verificação junto a cada envio ----------
  for (let i = order.length; i < plan.length; i++) {
    const p = plan[i];
    // Só para os testes locais: simula uma execução interrompida antes deste passo (nunca vale fora do nó local).
    if (local && process.env.DEMO_STOP_BEFORE && p.label.startsWith(process.env.DEMO_STOP_BEFORE + " "))
      throw new Error(`parada de teste antes de "${p.label}"`);
    // Imediatamente antes do envio: os estados ainda são os do passo anterior (não elimina corrida externa
    // posterior a esta leitura; a exclusão é a trava por manifesto e as verificações finais).
    await checkStates(i ? plan[i - 1].after : S0, `antes de "${p.label}": estado divergente`);
    m.steps[p.label] = { status: "sending" }; m.steps_order.push(p.label); save();
    const hash = await p.send();
    m.steps[p.label].hash = hash; save();
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    m.steps[p.label].status = r.status; m.steps[p.label].block = String(r.blockNumber); save();
    if (r.status !== "success") throw new Error(`"${p.label}": revertida`);
    proofs.push(...(await prove(p, m.steps[p.label])).proofs);
  }

  // ---------- Fase 3: verificações finais ----------
  const ledgerProofs = proofs.filter((x) => !["approve tesouraria", "cadastrar lojista", "4c lojista aprova a devolução"].includes(x.step));
  if (ledgerProofs.length !== 8) throw new Error(`esperava 8 provas de evento do ledger, há ${ledgerProofs.length}`);

  // Confere os recibos contra os eventos Settled lidos na cadeia.
  const b1 = m.steps["1 liquidar pedido pago"].block;
  if (!b1) throw new Error("manifesto sem o bloco da liquidação 1; reconcilie antes de conferir os recibos");
  const fromBlock = BigInt(b1);
  const evs = await ledger.getEvents.Settled({}, { fromBlock });
  const checks = {};
  for (const n of ["1", "4"]) {
    const rc = m.receipts[n];
    const ev = evs.find((e) => e.args.orderRef.toLowerCase() === rc.orderRef);
    checks[n] = ev ? verify(rc, { ...ev.args, ledger: ledger.address, chainId }) : ["evento não encontrado"];
    if (checks[n].length) throw new Error(`recibo ${n} não confere: ${checks[n].join(",")}`);
  }
  // Estados finais exigidos (enum: 0 None, 1 Settled, 2 RefundOpen, 3 Exposure, 4 Closed).
  const expected = { pedido1: 1, pedido3: 4, pedido4: 4 };
  const states = await checkStates(expected, "estado final divergente");
  console.log(JSON.stringify({ chainId, ledger: ledger.address, run, states, expected, receipts: "conferem", proofs: ledgerProofs, tokenProofs: proofs.length - ledgerProofs.length,
    steps: m.steps_order.map((l) => ({ l, ...m.steps[l] })) }, null, 2));
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
