#!/usr/bin/env bash
# v5: só a mensagem do caso 7a mudou (o estado alterado agora é pego na reconciliação, antes da fase de envios).
# v4: retomada do demo-flow (v3 + registros success exigem prova na cadeia e estados finais exigidos) com o mesmo manifesto, contra um nó local (npx hardhat node em outro terminal).
# Toda expectativa é if/else explícito: sucesso inesperado OU erro com mensagem errada fazem o script falhar.
set -u
RPC=http://127.0.0.1:8545
rpc() { curl -s -X POST -H 'content-type: application/json' --data "$1" $RPC; }
nonce() { rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionCount\",\"params\":[\"$1\",\"latest\"]}" | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["result"],16))'; }
OPS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
MER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
M=demo-manifest.local.json
L4="4d lojista devolve à tesouraria que pagou"
fail=0
ok()  { echo "OK $*"; }
bad() { echo "FALHA $*"; fail=1; }
run() { npx hardhat run scripts/demo-flow.cjs --network localhost >"$1" 2>&1; }
# expect_fail <saida> <padrão> <descrição>: precisa falhar E com a mensagem esperada.
expect_fail() {
  if run "$1"; then bad "$3: terminou com sucesso, esperava falha"
  elif grep -q -- "$2" "$1"; then ok "$3"
  else bad "$3: falhou com outra mensagem: $(tail -1 "$1")"; fi
}
both() { echo "$(nonce $OPS)/$(nonce $MER)"; }
same_nonces() { local now; now=$(both); if [ "$1" = "$now" ]; then ok "$2 (nonces $now)"; else bad "$2: nonces $1 -> $now"; fi; }
patch() { python3 - "$M" "$L4" "$1" <<'P'
import json,sys
path,label,expr=sys.argv[1:4]; m=json.load(open(path)); exec(expr); json.dump(m,open(path,"w"))
P
}

# 0. autoteste do próprio harness: uma falha com mensagem errada precisa ser detectada
rm -f $M $M.lock
fail_before=$fail; echo 'x' > /tmp/r0.txt
( run() { return 1; }; expect_fail /tmp/r0.txt "mensagem-que-nao-existe" "autoteste" ) | grep -q "^FALHA autoteste" \
  && ok "harness detecta falha com mensagem errada" || bad "harness não detectou mensagem errada"
fail=$fail_before

# 1. execução completa e retomada sem envio
if run /tmp/r1.txt; then ok "run1 completo"; else bad "run1: $(tail -1 /tmp/r1.txt)"; fi
n1=$(both)
if run /tmp/r2.txt; then ok "run2 retomada"; else bad "run2: $(tail -1 /tmp/r2.txt)"; fi
same_nonces "$n1" "retomada completa não envia nada"
LEDGER=$(python3 -c "import json;print(json.load(open('$M'))['ledger'])")
RUN=$(python3 -c "import json;print(json.load(open('$M'))['run'])")
export ORIG4D=$(python3 -c "import json;print(json.dumps(json.load(open('$M'))['steps']['$L4']))")
H4C=$(python3 -c "import json;s=json.load(open('$M'))['steps'];k=[x for x in s if x.startswith('4c ')][0];print(s[k]['hash'], s[k]['block'])")
O4D='json.loads(__import__("os").environ["ORIG4D"])'
restore4d() { patch "m['steps'][label]=$O4D"; }

# 2. envio interrompido antes do hash: para sem reenviar
patch 'm["steps"][label]={"status":"sending"}'
expect_fail /tmp/r3.txt "resultado desconhecido" "envio sem hash para em resultado desconhecido"
same_nonces "$n1" "nada reenviado após envio sem hash"

# 3. hash inexistente: para sem reenviar
patch 'm["steps"][label]={"status":"sending","hash":"0x"+"ab"*32}'
expect_fail /tmp/r4.txt "sem recibo" "hash sem recibo para sem reenviar"
same_nonces "$n1" "nada reenviado após hash sem recibo"

# 4. recibo revertido: para, grava status e bloco, não reenvia
REV=$(node tools/make-reverted-tx.cjs "$LEDGER" "$OPS") || bad "não gerou tx revertida"
n_rev=$(both)
patch "m['steps'][label]={'status':'sending','hash':'$REV'}"
expect_fail /tmp/r5.txt "revertida" "recibo revertido para"
st=$(python3 -c "import json;s=json.load(open('$M'))['steps']['$L4'];print(s['status'], 'block' in s)")
[ "$st" = "reverted True" ] && ok "status reverted e bloco gravados" || bad "manifesto após revertida: $st"
same_nonces "$n_rev" "nada reenviado após revertida"
REVBLOCK=$(python3 -c "import json;print(json.load(open('$M'))['steps']['$L4']['block'])")

# 4b. (v4) registros success sem prova: param sem reenviar, nonces dos dois signers inalterados
patch 'm["steps"][label]={"status":"success"}'
expect_fail /tmp/r5a.txt "sem hash ou bloco" "success sem hash nem bloco recusado"
patch "m['steps'][label]={'status':'success','hash':$O4D['hash']}"
expect_fail /tmp/r5b.txt "sem hash ou bloco" "success com hash e sem bloco recusado"
patch 'm["steps"][label]={"status":"success","hash":"0x"+"cd"*32,"block":"1"}'
expect_fail /tmp/r5c.txt "sem recibo na cadeia" "success com hash inexistente recusado"
patch "m['steps'][label]={'status':'success','hash':'$REV','block':'$REVBLOCK'}"
expect_fail /tmp/r5d.txt "revertida na cadeia" "success com tx revertida recusado"
set -- $H4C
patch "m['steps'][label]={'status':'success','hash':'$1','block':'$2'}"
expect_fail /tmp/r5e.txt "não corresponde ao passo" "success com a tx de outro passo (4c) recusado"
patch "m['steps'][label]=dict($O4D, block=str(int($O4D['block'])+1))"
expect_fail /tmp/r5f.txt "cadeia diz" "success com bloco divergente recusado"
same_nonces "$n_rev" "nada reenviado nos registros success sem prova"
restore4d

# 5. manifesto de outro ledger, de outro valor ou de outra execução: recusa
patch 'm["ledger"]="0x"+"11"*20'
expect_fail /tmp/r6.txt "sem código" "manifesto de outro ledger recusado (preflight: sem código)"
patch "m['ledger']='$LEDGER'; m['amountUnits']='999'"
expect_fail /tmp/r7.txt "amountUnits" "manifesto com outro valor recusado"
patch "m['amountUnits']='100000'"
if RUN_ID=outra npx hardhat run scripts/demo-flow.cjs --network localhost >/tmp/r8.txt 2>&1; then bad "RUN_ID diferente aceito"
elif grep -q "não de RUN_ID" /tmp/r8.txt; then ok "RUN_ID diferente do manifesto recusado"; else bad "RUN_ID: $(tail -1 /tmp/r8.txt)"; fi

# 6. dois processos no mesmo manifesto: o segundo é recusado antes de qualquer envio
echo 999999 > $M.lock
expect_fail /tmp/r9.txt "manifesto em uso" "trava impede processo concorrente"
rm -f $M.lock
same_nonces "$n_rev" "nenhum envio nos testes 5 e 6"

# 7a. (v4) estado alterado por operação posterior: diagnosticado, não corrigido (roda no fim, ver 7b)

# 7. retomada final ainda confere tudo
if run /tmp/r10.txt; then ok "retomada final confere recibos"; else bad "retomada final: $(tail -1 /tmp/r10.txt)"; fi
same_nonces "$n_rev" "retomada final não envia nada"
[ -e $M.lock ] && bad "trava ficou para trás" || ok "trava removida ao sair"

# 7a. (v4) estado alterado por operação posterior: diagnosticado, não corrigido
node tools/local-call.cjs "$LEDGER" "$OPS" openRefundCase "$RUN" 1 >/tmp/r11a.txt || bad "não alterou o pedido 1"
n_alt=$(both)
expect_fail /tmp/r11.txt "estado atual divergente do prefixo confirmado (10/10 passos): pedido1=3 (esperado 1)" "estado alterado depois é diagnosticado já na reconciliação"
same_nonces "$n_alt" "nada enviado diante do estado divergente"
rm -f $M

# 7b. (v4) fluxo incompleto: parado antes do 4d, pedido 4 em exposição, 4d marcado success sem prova
if DEMO_STOP_BEFORE=4d npx hardhat run scripts/demo-flow.cjs --network localhost >/tmp/r12.txt 2>&1; then bad "parada de teste não parou"
elif grep -q "parada de teste" /tmp/r12.txt; then ok "fluxo novo parado antes do 4d"; else bad "parada: $(tail -1 /tmp/r12.txt)"; fi
python3 - "$M" "$L4" <<'P'
import json,sys
path,label=sys.argv[1:3]; m=json.load(open(path)); m["steps"][label]={"status":"success"}; m["steps_order"].append(label); json.dump(m,open(path,"w"))
P
n_inc=$(both)
expect_fail /tmp/r13.txt "sem hash ou bloco" "fluxo incompleto com 4d success sem prova recusado (sai com erro)"
H4C2=$(python3 -c "import json;s=json.load(open('$M'))['steps'];k=[x for x in s if x.startswith('4c ')][0];print(s[k]['hash'], s[k]['block'])")
set -- $H4C2
patch "m['steps'][label]={'status':'success','hash':'$1','block':'$2'}"
expect_fail /tmp/r14.txt "não corresponde ao passo" "fluxo incompleto com 4d apontando para a tx do 4c recusado"
same_nonces "$n_inc" "nada enviado nos fluxos incompletos"
python3 - "$M" "$L4" <<'P'
import json,sys
path,label=sys.argv[1:3]; m=json.load(open(path)); m["steps"].pop(label); m["steps_order"].remove(label); json.dump(m,open(path,"w"))
P
if run /tmp/r15.txt; then ok "retomada normal íntegra envia só o 4d"; else bad "retomada normal: $(tail -1 /tmp/r15.txt)"; fi
st=$(python3 - /tmp/r15.txt <<'P'
import json,sys
t=open(sys.argv[1]).read(); j=json.loads(t[t.index("{"):])
print(j["states"]==j["expected"]=={"pedido1":1,"pedido3":4,"pedido4":4}, len(j["proofs"]))
P
)
[ "$st" = "True 8" ] && ok "estados finais 1/4/4 e 8 provas de evento" || bad "saída da retomada: $st"
n_after=$(both)
want=$(echo "$n_inc" | awk -F/ '{print $1"/"$2+1}')
[ "$n_after" = "$want" ] && ok "retomada enviou exatamente 1 tx, do lojista ($n_inc -> $n_after)" || bad "retomada: nonces $n_inc -> $n_after"
[ -e $M.lock ] && bad "trava ficou para trás (7b)" || ok "trava removida ao sair (7b)"
rm -f $M
echo "fail=$fail"
exit $fail
