# CertificadoCurso v2 — Certificação de curso via Smart Contract (sem carteiras de alunos)

Protótipo funcional derivado do TCC **"Blockchain e Smart Contracts: barreiras à sua adoção"**
(Arthur Naoto Miura, FEMA/IMESA, 2026), para cursos de curricularização da extensão.

**Decisões de arquitetura:**
- **Alunos não precisam de carteira.** Cada aluno é um ID anônimo on-chain:
  `keccak256(SAL + ":" + RA)`. Nenhum dado pessoal vai à rede pública (LGPD);
  o mapa RA→nome fica off-chain, com o professor (`dados-locais.json`).
- **Auto-execução:** o professor apenas valida presenças (é o *oráculo humano*).
  Ao encerrar o curso, **o contrato decide e emite sozinho** os certificados de
  quem atingiu a frequência mínima — o critério codificado substitui a decisão caso a caso.
- **Avaliação on-chain anônima:** códigos secretos de uso único, distribuídos
  embaralhados; qualquer carteira envia a transação (relayer), mas só um código
  válido registra nota. O evento publica o hash do código, então cada aluno pode
  conferir no Etherscan que sua nota entrou sem adulteração.

## Os 3 módulos

| Módulo | Off-chain | On-chain |
|---|---|---|
| 1. Inscrição | Google Forms → exportar CSV | `inscreverLote(cursoId, ids[])` |
| 2. Presença + emissão | chamada/lista da aula | `registrarPresenca` → `encerrarCurso` (auto-emite) |
| 3. Avaliação | distribuição dos códigos impressos | `habilitarAvaliacao` → `avaliar` → `mediaAvaliacao` |

## Instalação e testes

```bash
npm install
npx hardhat compile
npx hardhat test                      # 12 testes + relatório de gas
npx hardhat run scripts/deploy.js     # deploy + demo completa na rede local
```

> `SOLC_LOCAL=1` só é necessário em ambientes sem acesso a binaries.soliditylang.org.

## Passo a passo de um curso real (Sepolia)

**Preparação (uma vez):** copie `.env.example` para `.env` e preencha RPC (Alchemy/Infura,
grátis), chave privada de uma carteira **exclusiva de testes** com Sepolia ETH de faucet,
e um `SAL_ALUNOS` secreto. Depois:

```bash
npx hardhat run scripts/deploy.js --network sepolia    # anote o endereço no .env (CONTRATO=...)
npx hardhat verify --network sepolia $CONTRATO         # publica o código no Etherscan
```

**1) Criar o curso** (console: `npx hardhat console --network sepolia`):
```js
const c = await ethers.getContractAt("CertificadoCurso", process.env.CONTRATO)
await c.criarCurso("Nome do Curso", 20, 8, 75)   // 20h, 8 aulas, 75% de presença
```

**2) Inscrições via Google Forms:** crie um formulário com os campos **Nome**, **E-mail**
e **RA**. Ao fechar as inscrições: Respostas → ⋮ → *Fazer download das respostas (.csv)*.
Então:
```bash
CURSO_ID=1 CSV=inscricoes.csv npx hardhat run scripts/importar-inscricoes.js --network sepolia
```
(Veja `inscricoes.exemplo.csv`. O script gera os IDs anônimos e guarda o mapa localmente.)

**3) A cada aula, validar presença:**
```bash
CURSO_ID=1 AULA=3 RAS="2311600101,2311600102" npx hardhat run scripts/registrar-presenca.js --network sepolia
```

**4) Encerrar o curso — a emissão é automática:**
```bash
CURSO_ID=1 npx hardhat run scripts/encerrar-curso.js --network sepolia
```
O script lista os certificados emitidos com nº, RA e presenças. Imprima o nº do
certificado (`certId`) e o `alunoId` no PDF/documento entregue ao aluno.

**5) Avaliação do curso:**
```bash
CURSO_ID=1 QTD=25 npx hardhat run scripts/gerar-codigos.js --network sepolia   # 1 código por certificado
# distribua os códigos impressos, embaralhados; cada aluno avalia (na "urna" do laboratório):
CURSO_ID=1 NOTA=5 CODIGO=AVAL-a1b2c3 COMENTARIO="Otimo" npx hardhat run scripts/avaliar.js --network sepolia
```
Média pública: `await c.mediaAvaliacao(1)` → `[450, 18]` = nota 4,50 com 18 votos.

## Verificação por terceiros (sem custo)

No Etherscan (aba *Read Contract*) ou via console:
- `verificarCertificado(certId)` → válido?, ID do aluno, curso, carga horária, presenças, data;
- `verificarPorAluno(cursoId, alunoId)` → nº do certificado e validade;
- `mediaAvaliacao(cursoId)` → transparência da avaliação do curso.

## Custos de gas medidos (solc 0.8.28, optimizer 200)

| Operação | Gas |
|---|---:|
| Deploy | ~1,9M |
| inscreverLote (3 alunos) | 192.841 |
| registrarPresenca (3 alunos) | 175.718 |
| encerrarCurso c/ auto-emissão (3 certs) | 329.392 |
| habilitarAvaliacao (3 códigos) | 98.910 |
| avaliar | 39.616 |

## Conexão com o TCC

| Barreira analisada | Como o protótipo a evidencia/mitiga |
|---|---|
| Problema do Oráculo | Presença atestada pelo professor: o elo humano é explícito e auditável |
| Imutabilidade | Critério de emissão inalterável após o deploy + `revogarCertificado` como válvula de governança |
| Custos operacionais (gas) | Medição por operação; custo cresce com nº de alunos (loops) |
| Barreiras legais (LGPD) | Design por IDs anônimos: nenhum dado pessoal on-chain |
| Governança institucional | `Ownable` centraliza no professor — trade-off documentado |

## Limitações conhecidas (honestidade metodológica)

- O relayer da avaliação pode, em tese, alterar a nota antes de enviar; a mitigação é a
  auditoria pelo aluno (evento com hash do seu código no Etherscan).
- O professor, como oráculo, continua sendo o ponto de confiança da presença — ilustração
  prática do Problema do Oráculo, e material de discussão para o curso.
- `encerrarCurso` itera sobre os inscritos: adequado a turmas (dezenas/centenas), não a milhares.
