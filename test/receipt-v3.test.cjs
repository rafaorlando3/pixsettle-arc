// v3: aceitação do grupo 1 da REVISAO-A2 (Codex, 01/10 04h40): semântica do recibo, diagnósticos sem exceção,
// Unicode inválido e vetores canônicos conferidos contra uma implementação independente do RFC 8785.
const { expect } = require("chai");
const { createHash } = require("node:crypto");
const { keccak256, toHex } = require("viem");
const jcs = require("canonicalize"); // implementação independente (npm canonicalize), só para teste
const { buildReceipt, digest, verify, canon, validate } = require("../scripts/receipt.cjs");

const base = { chainId: 5042002, ledger: "0x" + "AB".repeat(20), orderRef: keccak256(toHex("o")), settlementId: keccak256(toHex("s")),
  merchant: "0x" + "CD".repeat(20), amount: 100000n, pixE2eId: "E-SIMULADO-1" };
const evFor = (r) => ({ receiptDigest: digest(r), orderRef: r.orderRef, settlementId: r.settlementId, merchant: r.merchant,
  amount: BigInt(r.amount), ledger: r.ledger, chainId: Number(r.chainId) });
// Recibo forjado JÁ com outro conteúdo, com o digest dele mesmo gravado no "evento": o digest bate,
// a semântica não. Antes da v3, verify aceitava currency USDT assim.
const forged = (patch, pixPatch) => {
  const r = JSON.parse(JSON.stringify(buildReceipt(base)));
  Object.assign(r, patch || {}); Object.assign(r.pix, pixPatch || {});
  const d = "0x" + createHash("sha256").update(Buffer.from(jcs(r), "utf8")).digest("hex");
  return { r, ev: { ...evFor(buildReceipt(base)), receiptDigest: d } };
};

describe("recibo v3: semântica", () => {
  it("recibo válido segue aceito", () => {
    const r = buildReceipt(base);
    expect(verify(r, evFor(r))).to.deep.equal([]);
  });
  it("recibo criado com USDT e digest correspondente é recusado", () => {
    const { r, ev } = forged({ currency: "USDT" });
    expect(verify(r, ev)).to.deep.equal(["recibo inválido: currency deve ser USDC"]);
  });
  it("pix.status diferente de simulated, com digest correspondente, é recusado", () => {
    for (const st of ["confirmed", "settled", ""]) {
      const { r, ev } = forged({}, { status: st });
      expect(verify(r, ev)[0]).to.match(/^recibo inválido: pix.status/);
    }
  });
  it("tipos e formatos inválidos viram diagnóstico, nunca exceção", () => {
    const cases = [
      [{}, { e2eId: 123 }, /pix.e2eId deve ser string/],
      [{}, { e2eId: "" }, /pix.e2eId vazio/],
      [{ amount: "0" }, null, /amount deve ser positivo/],
      [{ amount: "0100000" }, null, /amount deve ser inteiro decimal canônico/],
      [{ amount: "1e5" }, null, /amount deve ser inteiro/],
      [{ amount: (1n << 256n).toString() }, null, /amount fora de uint256/],
      [{ amount: 100000 }, null, /amount deve ser string/],
      [{ chainId: "05042002" }, null, /chainId deve ser inteiro decimal canônico/],
      [{ chainId: 5042002 }, null, /chainId deve ser string/],
      [{ pix: "simulated" }, null, /pix deve ser objeto/],
      [{ extra: "x" }, null, /campos do recibo/],
      [{ orderRef: ["0x"] }, null, /orderRef deve ser string/],
    ];
    for (const [patch, pixPatch, re] of cases) {
      const r = JSON.parse(JSON.stringify(buildReceipt(base)));
      Object.assign(r, patch); if (pixPatch) Object.assign(r.pix, pixPatch);
      let out; expect(() => { out = verify(r, evFor(buildReceipt(base))); }).to.not.throw();
      expect(out.length, JSON.stringify(patch || pixPatch)).to.equal(1);
      expect(out[0]).to.match(re);
    }
    for (const bad of [null, undefined, "x", [], 5]) expect(verify(bad, {})[0]).to.match(/^recibo inválido/);
  });
  it("evento malformado vira diagnóstico, nunca exceção", () => {
    const r = buildReceipt(base);
    for (const ev of [null, {}, { ...evFor(r), amount: -1n }, { ...evFor(r), receiptDigest: 5 }, { ...evFor(r), chainId: "abc" },
      { ...evFor(r), merchant: "0x12" }]) {
      let out; expect(() => { out = verify(r, ev); }).to.not.throw();
      expect(out[0]).to.match(/^evento inválido/);
    }
  });
  it("divergências de campo seguem apontadas", () => {
    const r = buildReceipt(base);
    expect(verify(r, { ...evFor(r), amount: 100001n })).to.deep.equal(["amount"]);
    expect(verify(r, { ...evFor(r), chainId: 1 })).to.deep.equal(["chainId"]);
  });
});

describe("recibo v3: Unicode e canonicalização", () => {
  it("surrogate isolado é recusado pelo canonicalizador e pela validação", () => {
    expect(() => canon({ a: "x\ud800" })).to.throw(/surrogate/);
    expect(() => canon({ ["k\udc00"]: "x" })).to.throw(/surrogate/);
    const r = JSON.parse(JSON.stringify(buildReceipt(base))); r.pix.e2eId = "E\ud800";
    expect(verify(r, evFor(buildReceipt(base)))[0]).to.match(/^recibo inválido/);
  });
  it("fora do domínio ASCII é recusado (o recibo não alega JCS irrestrito)", () => {
    const r = JSON.parse(JSON.stringify(buildReceipt(base))); r.pix.e2eId = "E-ação";
    expect(verify(r, evFor(buildReceipt(base)))[0]).to.match(/^recibo inválido/);
    expect(() => validate({ ...buildReceipt(base), currency: "USDC " })).to.throw();
  });
  it("vetores: canon == implementação independente do RFC 8785 no domínio aceito", () => {
    const vecs = [buildReceipt(base), buildReceipt({ ...base, amount: 1n, chainId: 5042, pixE2eId: "a.b:c_d-E" }),
      buildReceipt({ ...base, amount: (1n << 256n) - 1n })];
    for (const r of vecs) expect(canon(r)).to.equal(jcs(r));
    // fora do recibo, o canonicalizador de strings também bate com o JCS em Unicode bem formado
    for (const o of [{ b: "é", a: " ", c: "😀", d: "\u0000\u001f\"\\" }, { "€": "x", "\u0080": "y", aa: "", a: "z" }])
      expect(canon(o)).to.equal(jcs(o));
  });
  it("digest de um vetor fixo não muda entre versões", () => {
    expect(digest(buildReceipt(base))).to.equal("0x" + createHash("sha256").update(jcs(buildReceipt(base))).digest("hex"));
  });
});
