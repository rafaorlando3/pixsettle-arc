// Recibo canônico do PixSettle Arc, versão "pixsettle-arc-receipt/1".
// v3: o recibo é validado pela semântica, não só pelo digest. Esquema fechado:
//   objeto raiz e objeto pix sem chaves extras; todas as folhas são strings ASCII de um domínio restrito;
//   currency = "USDC"; pix.status = "simulated"; pix.e2eId não vazio ([A-Za-z0-9._:-], até 80);
//   chainId e amount em decimal canônico (sem zero à esquerda), amount > 0, ambos < 2^256.
// Canonicalização: chaves ordenadas, sem espaços. Como o domínio aceito é só objetos e strings ASCII
// imprimíveis, a saída coincide com o RFC 8785 (JCS) NESSE domínio; fora dele o recibo é recusado.
// Strings com surrogate isolado são recusadas pelo canonicalizador (RFC 8785 §3.2.2.2).
// digest = sha256(utf8(canônico)), gravado on-chain em Settled.receiptDigest.
// O digest prova que o recibo não mudou depois de registrado. NÃO prova que um Pix real aconteceu:
// nesta demo o Pix é simulado e o estado é informado pelo operador.
const { createHash } = require("node:crypto");

const VERSION = "pixsettle-arc-receipt/1";
const FIELDS = ["amount", "chainId", "currency", "ledger", "merchant", "orderRef", "pix", "settlementId", "v"];
const PIX_FIELDS = ["e2eId", "status"];
const UINT256_LIMIT = 1n << 256n;
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function canon(v) {
  if (typeof v === "string") {
    if (!v.isWellFormed()) throw new Error("string com surrogate isolado");
    return JSON.stringify(v);
  }
  if (isPlainObject(v)) {
    return "{" + Object.keys(v).sort().map((k) => {
      if (!k.isWellFormed()) throw new Error("chave com surrogate isolado");
      return JSON.stringify(k) + ":" + canon(v[k]);
    }).join(",") + "}";
  }
  throw new Error("recibo aceita só objetos e strings");
}

function buildReceipt({ chainId, ledger, orderRef, settlementId, merchant, amount, pixE2eId }) {
  const r = {
    v: VERSION, chainId: String(chainId), ledger: String(ledger).toLowerCase(), orderRef, settlementId,
    merchant: String(merchant).toLowerCase(), amount: String(amount), currency: "USDC",
    pix: { status: "simulated", e2eId: pixE2eId },
  };
  validate(r);
  return r;
}

function canonicalUint(s, name, { positive }) {
  if (typeof s !== "string" || !/^(0|[1-9][0-9]*)$/.test(s)) throw new Error(`${name} deve ser inteiro decimal canônico em texto`);
  const n = BigInt(s);
  if (n >= UINT256_LIMIT) throw new Error(`${name} fora de uint256`);
  if (positive && n === 0n) throw new Error(`${name} deve ser positivo`);
  return n;
}

function validate(r) {
  if (!isPlainObject(r)) throw new Error("recibo deve ser objeto");
  const keys = Object.keys(r).sort();
  if (JSON.stringify(keys) !== JSON.stringify(FIELDS)) throw new Error("campos do recibo: " + keys.join(","));
  if (!isPlainObject(r.pix)) throw new Error("pix deve ser objeto");
  if (JSON.stringify(Object.keys(r.pix).sort()) !== JSON.stringify(PIX_FIELDS)) throw new Error("campos pix");
  for (const k of FIELDS.filter((f) => f !== "pix")) {
    if (typeof r[k] !== "string") throw new Error(`${k} deve ser string`);
    if (!ASCII_PRINTABLE.test(r[k])) throw new Error(`${k} fora do domínio ASCII`);
  }
  for (const k of PIX_FIELDS) if (typeof r.pix[k] !== "string") throw new Error(`pix.${k} deve ser string`);
  if (r.v !== VERSION) throw new Error("versão desconhecida");
  if (r.currency !== "USDC") throw new Error("currency deve ser USDC");
  if (r.pix.status !== "simulated") throw new Error("pix.status deve ser simulated");
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(r.pix.e2eId)) throw new Error("pix.e2eId vazio ou fora do domínio");
  canonicalUint(r.chainId, "chainId", { positive: true });
  canonicalUint(r.amount, "amount", { positive: true });
  for (const k of ["ledger", "merchant"]) if (!/^0x[0-9a-f]{40}$/.test(r[k])) throw new Error(k);
  for (const k of ["orderRef", "settlementId"]) if (!/^0x[0-9a-f]{64}$/.test(r[k])) throw new Error(k);
}

const digest = (r) => "0x" + createHash("sha256").update(Buffer.from(canon(r), "utf8")).digest("hex");

const hexOf = (v, name, len) => {
  if (typeof v !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${len}}$`).test(v)) throw new Error(`evento: ${name} inválido`);
  return v.toLowerCase();
};
const uintOf = (v, name) => {
  if (typeof v === "bigint") { if (v < 0n || v >= UINT256_LIMIT) throw new Error(`evento: ${name} fora de uint256`); return String(v); }
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v)) return v;
  throw new Error(`evento: ${name} inválido`);
};

/** Confere o recibo contra os campos do evento Settled lido na cadeia. Nunca lança: devolve a lista de
 *  divergências ou diagnósticos ("recibo inválido: ...", "evento inválido: ..."). */
function verify(r, ev) {
  try { validate(r); } catch (e) { return ["recibo inválido: " + e.message]; }
  let e;
  try {
    if (!ev || typeof ev !== "object") throw new Error("evento ausente");
    e = { receiptDigest: hexOf(ev.receiptDigest, "receiptDigest", 64), orderRef: hexOf(ev.orderRef, "orderRef", 64),
      settlementId: hexOf(ev.settlementId, "settlementId", 64), merchant: hexOf(ev.merchant, "merchant", 40),
      ledger: hexOf(ev.ledger, "ledger", 40), amount: uintOf(ev.amount, "amount"), chainId: uintOf(ev.chainId, "chainId") };
  } catch (err) { return ["evento inválido: " + err.message]; }
  let d;
  try { d = digest(r); } catch (err) { return ["recibo inválido: " + err.message]; }
  const errs = [];
  if (d !== e.receiptDigest) errs.push("digest");
  if (r.orderRef !== e.orderRef) errs.push("orderRef");
  if (r.settlementId !== e.settlementId) errs.push("settlementId");
  if (r.merchant !== e.merchant) errs.push("merchant");
  if (r.amount !== e.amount) errs.push("amount");
  if (r.ledger !== e.ledger) errs.push("ledger");
  if (r.chainId !== e.chainId) errs.push("chainId");
  return errs;
}

module.exports = { VERSION, canon, buildReceipt, digest, verify, validate };
