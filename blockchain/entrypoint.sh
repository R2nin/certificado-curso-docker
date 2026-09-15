#!/bin/sh
# Sobe o nó Hardhat escutando em 0.0.0.0 (para outros contêineres da rede
# do Compose alcançarem) e, assim que o RPC responder, faz o deploy do
# contrato, publicando endereço + ABI em /shared/contrato.json.
set -e

echo "[blockchain] iniciando nó Hardhat..."
npx hardhat node --hostname 0.0.0.0 &
NODE_PID=$!

echo "[blockchain] aguardando RPC e fazendo deploy..."
npx hardhat run blockchain/deploy-docker.js --network localhost

echo "[blockchain] pronto. Nó ativo na porta 8545."
wait $NODE_PID
