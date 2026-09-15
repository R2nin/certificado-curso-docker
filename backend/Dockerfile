# API Express (relayer). Imagem leve: só express + pg + ethers.
FROM node:20-alpine

WORKDIR /app

# Dependências primeiro (cache de camadas do Docker)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Código da API
COPY server.js chain.js db.js ./

# Executa como usuário sem privilégios (boa prática)
USER node

EXPOSE 3000
CMD ["node", "server.js"]
