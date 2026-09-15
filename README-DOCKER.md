# CertificadoCurso v2 — versão conteinerizada (trabalho de Contêineres)

Empacotamento com **Docker + Compose** do protótipo do TCC
*"Blockchain e Smart Contracts: barreiras à sua adoção"* (Arthur Naoto Miura, FEMA/IMESA, 2026).
A aplicação de certificação de cursos de extensão agora roda em **quatro contêineres**,
cada um isolado no seu serviço e orquestrados por um único `docker-compose.yml`.

> O README original do protótipo (contrato, scripts Hardhat, deploy em Sepolia)
> continua em [`README.md`](README.md). Este documenta a parte de contêineres.

## Arquitetura

```
navegador ── localhost:8080 ──▶ ┌─────────────────────────────────────────────────┐
                                │        rede virtual criada pelo Compose         │
                                │                                                 │
                                │  frontend ──/api──▶ backend ──┬──▶ db:5432      │
                                │  nginx:1.27-alpine  node:20   │    postgres:16  │
                                │  página + proxy     Express   │    ⛁ pgdata     │
                                │                     relayer   │                 │
                                │                               └──▶ blockchain:8545
                                │                                    nó Hardhat   │
                                │                                    ⛁ chain-shared
                                └─────────────────────────────────────────────────┘
```

| Serviço | Imagem base | Papel |
|---|---|---|
| `frontend` | nginx:1.27-alpine | Página de documentação + painel; proxy `/api` → backend (sem CORS, uma porta só) |
| `backend` | node:20-alpine | API Express, **relayer**: dados pessoais → Postgres; IDs anônimos e transações → contrato |
| `db` | postgres:16-alpine | O que **não** vai à blockchain (LGPD): mapa RA → nome/e-mail e códigos de avaliação |
| `blockchain` | node:20-bookworm-slim | Nó Hardhat local; compila no build, faz deploy no start e publica endereço+ABI |

A separação é também conceitual: o banco guarda o off-chain sensível, o contrato
recebe apenas `keccak256(sal + ":" + RA)` e as regras de emissão — a mesma decisão
LGPD do protótipo, agora com fronteiras físicas entre os serviços.

## Como executar

Pré-requisito: Docker Desktop (ou Docker Engine + Compose v2).

```bash
# 1) variáveis de ambiente (credenciais NUNCA ficam no código)
cp .env.docker.example .env
#    edite POSTGRES_PASSWORD e SAL_ALUNOS

# 2) build + subida dos 4 serviços
docker compose up --build

# 3) abra a página
#    http://localhost:8080
```

A primeira subida compila o contrato e baixa as imagens (alguns minutos).
Nas seguintes, o cache de camadas dos Dockerfiles torna tudo rápido.

Comandos úteis:

```bash
docker compose up -d          # em segundo plano
docker compose logs -f backend
docker compose ps
docker compose down           # para tudo; volume pgdata SOBREVIVE
docker compose down -v        # reset total (apaga banco e contrato)
```

> **Sem acesso a binaries.soliditylang.org no build?** Use o fallback solc-js
> já embutido no projeto: `docker compose build --build-arg SOLC_LOCAL=1 blockchain`.

## Conceitos Docker demonstrados

- **Dockerfile (×3)** — `frontend/`, `backend/` e `blockchain/`. Boas práticas
  aplicadas: dependências copiadas antes do código (cache de camadas), imagens
  alpine/slim, `USER node` no backend, compilação do contrato no build.
- **Compose** — `docker-compose.yml` é o arquivo central: serviços, portas,
  volumes, variáveis e ordem de subida (`depends_on` com `service_healthy`
  no Postgres via `pg_isready`).
- **Redes de contêineres** — o Compose cria a rede com DNS interno; a API acessa
  `postgres://…@db:5432/…` e `http://blockchain:8545` pelos **nomes dos serviços**.
  Banco e nó não publicam porta no host: só o frontend é alcançável de fora.
- **Volumes** — `pgdata` (persistência: derrubar o contêiner não apaga inscrições)
  e `chain-shared` (comunicação: o nó publica `contrato.json` com endereço+ABI e o
  backend lê ao subir, sem hardcode). O `init.sql` entra por bind mount em
  `/docker-entrypoint-initdb.d`.
- **Variáveis de ambiente** — credenciais do Postgres, chave do relayer e o sal
  dos IDs anônimos vêm do `.env` (fora do versionamento) e chegam via Compose;
  o código só lê `process.env`.

## Fluxo pela página (http://localhost:8080)

1. **Criar o curso** — nome, carga horária, nº de aulas, presença mínima;
2. **Inscrever alunos** — cole linhas `nome, e-mail, RA` (formato do CSV do
   Google Forms): nomes ficam no Postgres, só hashes vão ao contrato;
3. **Registrar presença** — professor como oráculo, aula a aula;
4. **Encerrar** — o **contrato auto-emite** os certificados de quem atingiu a
   frequência mínima;
5. **Avaliação anônima** — gere códigos (1 por certificado), distribua
   embaralhados e registre notas pela "urna"; média pública on-chain.

E, para terceiros, **Verificar certificado** pelo número impresso — leitura
pública, sem custo.

A API também responde direto (via proxy): `GET /api/health`, `GET /api/cursos`,
`GET /api/certificados/:id` etc. — ver rotas em `backend/server.js`.

## Avisos

- **Windows / fim de linha:** `blockchain/entrypoint.sh` precisa estar com **LF**.
  O `.gitattributes` incluso já força isso; se você editar o arquivo fora do Git,
  confira o modo de quebra de linha no editor (CRLF quebra o shell no contêiner).
- **Chave privada:** a do `.env.docker.example` é a conta #0 pública do nó Hardhat —
  serve **apenas** para a rede local de desenvolvimento. Em rede real (Sepolia),
  siga o README original e nunca versione chaves.
- **Chain efêmera:** o nó Hardhat não persiste estado entre reinícios do contêiner;
  o contrato é re-implantado a cada `up`. O banco, com volume, persiste — se
  reiniciar só o nó, os dados do Postgres deixam de casar com a chain zerada.
  Para recomeçar limpo: `docker compose down -v`. (Num deploy real em testnet
  a chain persiste por natureza — e aí o volume do banco mostra seu valor.)

## Estrutura

```
├── docker-compose.yml        # orquestração dos 4 serviços
├── .env.docker.example       # variáveis (copiar para .env)
├── frontend/                 # nginx: Dockerfile, nginx.conf, public/ (página)
├── backend/                  # API: Dockerfile, server.js, chain.js, db.js
├── db/init.sql               # schema aplicado na 1ª subida do Postgres
├── blockchain/               # Dockerfile, entrypoint.sh, deploy-docker.js
├── contracts/ scripts/ test/ # projeto Hardhat original (inalterado)
└── README.md                 # documentação original do protótipo
```
