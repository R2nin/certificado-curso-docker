# Nó Hardhat + deploy automático do CertificadoCurso.
# Contexto de build = raiz do projeto (precisa de contracts/ e hardhat.config.js).
# bookworm-slim (glibc) em vez de alpine: o binário nativo do solc exige glibc.
FROM node:20-bookworm-slim

WORKDIR /app

# 1) Dependências primeiro: enquanto package.json não mudar, o Docker
#    reaproveita esta camada do cache (build muito mais rápido).
COPY package.json ./
RUN npm install --no-audit --no-fund

# 2) Código do projeto Hardhat
COPY hardhat.config.js ./
COPY contracts/ ./contracts/
COPY blockchain/deploy-docker.js ./blockchain/
COPY blockchain/entrypoint.sh ./blockchain/

# 3) Compila o contrato já no build da imagem (start do contêiner fica rápido).
#    Sem acesso a binaries.soliditylang.org? Rode:
#    docker compose build --build-arg SOLC_LOCAL=1 blockchain
ARG SOLC_LOCAL=0
ENV SOLC_LOCAL=${SOLC_LOCAL}
RUN npx hardhat compile

RUN chmod +x ./blockchain/entrypoint.sh

EXPOSE 8545
ENTRYPOINT ["./blockchain/entrypoint.sh"]
