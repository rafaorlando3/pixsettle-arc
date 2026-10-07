#!/usr/bin/env bash
# v5: reconciliação sem envios antes do primeiro passo ausente (pedido da REVISAO-A2 de 06h40, Codex).
# Contra um nó local (npx hardhat node em outro terminal). Cada cenário começa com manifesto novo (ledger novo).
# Toda expectativa é if/else explícito; nonces dos DOIS signers conferidos em cada retomada recusada.
set -u
RPC=http://127.0.0.1:8545
rpc() { curl -s -X POST -H 'content-type: application/json' --data "$1" $RPC; }
nonce() { rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionCount\",\"params\":[\"$1\",\"latest\"]}" | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["result"],16))'; }
OPS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
MER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
M=demo-manifest.local.json
fail=0
ok()  { echo "OK $*"; }
bad() { echo "FALHA $*"; fail=1; }
run() { npx hardhat run scripts/demo-flow.cjs --network localhost >"$1" 2>&1; }
expect_fail() {
  if run "$1"; then bad "$3: terminou com sucesso, esperava falha"
  elif grep -qF -- "$2" "$1"; then ok "$3"
  else bad "$3: falhou com outra mensagem: $(tail -1 "$1")"; fi
}
both() { echo "$(nonce $OPS)/$(nonce $MER)"; }
same_nonces() { local now; now=$(both); if [ "$1" = "$now" ]; then ok "$2 (nonces $now)"; else bad "$2: nonces $1 -> $now"; fi; }
delta() { # delta <antes> <ops+> <mer+> <descrição>
  local now want; now=$(both); want=$(echo "$1" | awk -F/ -v a="$2" -v b="$3" '{print $1+a"/"$2+b}')
  [ "$now" = "$want" ] && ok "$4 ($1 -> $now)" || bad "$4: nonces $1 -> $now, esperado $want"; }
patch() { python3 - "$M" "$1" <<'P'
import json,sys
path,expr=sys.argv[1:3]; m=json.load(open(path)); S=m["steps"]; O=m["steps_order"]
def k(p): return [x for x in O if x.startswith(p+" ")][0]
exec(expr); json.dump(m,open(path,"w"))
P
}
fresh_stop() { # fresh_stop <passo>: execução nova interrompida antes do passo
  rm -f $M $M.lock
  if DEMO_STOP_BEFORE=$1 npx hardhat run scripts/demo-flow.cjs --network localhost >/tmp/c-stop-$1.txt 2>&1; then bad "parada antes de $1 não parou"
  elif grep -q "parada de teste" /tmp/c-stop-$1.txt; then ok "execução nova parada antes de $1"; else bad "parada $1: $(tail -1 /tmp/c-stop-$1.txt)"; fi
  LEDGER=$(python3 -c "import json;print(json.load(open('$M'))['ledger'])"); RUN=$(python3 -c "import json;print(json.load(open('$M'))['run'])")
}
states() { for n in 1 3 4; do node tools/local-call.cjs "$LEDGER" "$OPS" state "$RUN" $n | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"],end="")'; [ $n = 4 ] || printf /; done; }
finish_ok() { # finish_ok <saida> <ops+> <mer+> <antes> <descrição>
  if run "$1"; then ok "$5: retomada terminou"; else bad "$5: $(tail -1 "$1")"; fi
  local st; st=$(python3 - "$1" <<'P'
import json,sys
t=open(sys.argv[1]).read(); j=json.loads(t[t.index("{"):]) if "{" in t else {}
print(j.get("states")==j.get("expected")=={"pedido1":1,"pedido3":4,"pedido4":4}, len(j.get("proofs",[])))
P
)
  [ "$st" = "True 8" ] && ok "$5: estados finais 1/4/4 e 8 provas" || bad "$5: saída $st"
  delta "$4" "$2" "$3" "$5: envios exatos"
  [ -e $M.lock ] && bad "$5: trava ficou" || true
}

# A. Contraexemplo A: parada antes de 4c; 4c ausente e 4d registrado como success sem hash/bloco.
fresh_stop 4c
st0=$(states); [ "$st0" = "1/4/3" ] && ok "A: estado antes da retomada 1/4/3 (pedido 4 em exposição)" || bad "A: estado $st0"
patch 'S["4d lojista devolve à tesouraria que pagou"]={"status":"success"}; O.append("4d lojista devolve à tesouraria que pagou")'
nA=$(both)
expect_fail /tmp/c-A.txt 'manifesto com lacuna: "4c lojista aprova a devolução" ausente' "A: lacuna 4c com 4d inválido recusada antes de qualquer envio"
same_nonces "$nA" "A: nenhum envio na retomada recusada"
# A'. mesma lacuna, mas 4d com hash/bloco reais de outro passo: também recusada pela lacuna
patch 'S[k("4d")]={"status":"success","hash":S[k("4b")]["hash"],"block":S[k("4b")]["block"]}'
expect_fail /tmp/c-A2.txt "manifesto com lacuna" "A': lacuna 4c com 4d apontando para tx real recusada"
same_nonces "$nA" "A': nenhum envio"
# A''. registro "sending" que não é o último: recusado
patch 'S[k("4d")]={"status":"sending"}; S["4c lojista aprova a devolução"]={"status":"sending"}; O.remove(k("4d")); O.append("4c lojista aprova a devolução"); O.append("4d lojista devolve à tesouraria que pagou")'
expect_fail /tmp/c-A3.txt '"4c lojista aprova a devolução": registro "sending" antes de outros registros' "A'': sending no meio recusado"
same_nonces "$nA" "A'': nenhum envio"
# A'''. ordem trocada (3b antes de 3a) recusada
patch 'S.pop(k("4c")); S.pop(k("4d")); O.remove(k("4c")); O.remove(k("4d")); i=O.index(k("3a")); O[i],O[i+1]=O[i+1],O[i]'
expect_fail /tmp/c-A4.txt "manifesto fora de ordem" "A''': ordem trocada recusada"
same_nonces "$nA" "A''': nenhum envio"
# Controle positivo antes de 4c: restaurado, envia só 4c e 4d (2 tx do lojista)
patch 'i=O.index(k("3b")); O[i],O[i+1]=O[i+1],O[i]'
finish_ok /tmp/c-A-ok.txt 0 2 "$nA" "controle antes de 4c"
n=$(both); if run /tmp/c-A-again.txt; then ok "fluxo completo retomado"; else bad "fluxo completo: $(tail -1 /tmp/c-A-again.txt)"; fi
same_nonces "$n" "fluxo já completo não envia nada"

# B. Contraexemplo B: parada antes de 4d; pedido 1 alterado de Settled para Exposure antes da retomada.
fresh_stop 4d
node tools/local-call.cjs "$LEDGER" "$OPS" openRefundCase "$RUN" 1 >/tmp/c-B-prep.txt || bad "B: não alterou o pedido 1"
st0=$(states); [ "$st0" = "3/4/3" ] && ok "B: divergência preparada antes da retomada, estado 3/4/3 (tx de preparo $(python3 -c "import json;print(json.load(open('/tmp/c-B-prep.txt'))['hash'][:12])") não conta)" || bad "B: estado $st0"
nB=$(both)
expect_fail /tmp/c-B.txt "estado atual divergente do prefixo confirmado (9/10 passos): pedido1=3 (esperado 1)" "B: estado divergente recusado antes de enviar 4d"
same_nonces "$nB" "B: nenhum envio na retomada recusada"
st1=$(states); [ "$st1" = "3/4/3" ] && ok "B: estado inalterado depois da recusa ($st1)" || bad "B: estado $st1"

# C. Controle positivo antes de 4d: envia só o retorno (1 tx do lojista)
fresh_stop 4d
nC=$(both)
finish_ok /tmp/c-C-ok.txt 0 1 "$nC" "controle antes de 4d"

# D. Passo 2 apontando para a tx válida do passo 1 (mesma calldata, evento diferente)
fresh_stop 3a
patch 'S[k("2")]=dict(S[k("1")])'
nD=$(both)
expect_fail /tmp/c-D.txt 'sem o evento SettlementReplayed esperado do passo' "D: passo 2 com a tx do passo 1 recusado pelo evento"
same_nonces "$nD" "D: nenhum envio"
# D'. mesmo registro com passos posteriores pendentes mais longe (parada antes de 4c)
fresh_stop 4c
patch 'S[k("2")]=dict(S[k("1")])'
nD2=$(both)
expect_fail /tmp/c-D2.txt 'sem o evento SettlementReplayed esperado do passo' "D': passo 2 com a tx do passo 1 recusado antes do 4c"
same_nonces "$nD2" "D': nenhum envio"
rm -f $M $M.lock
echo "fail=$fail"
exit $fail
