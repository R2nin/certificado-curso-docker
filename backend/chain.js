// Conexão com o contrato: lê endereço + ABI do arquivo publicado pelo
// contêiner blockchain no volume compartilhado e assina as transações
// com a chave do professor/relayer (variável de ambiente PRIVATE_KEY).
const fs = require("fs");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "http://blockchain:8545";
const CONTRATO_INFO = process.env.CONTRATO_INFO || "/shared/contrato.json";
const SAL = process.env.SAL_ALUNOS || "";

let contrato = null;
let info = null;

/** ID anônimo do aluno: keccak256(SAL + ":" + RA) — mesmo cálculo do scripts/lib.js */
function alunoId(ra) {
  return ethers.keccak256(ethers.toUtf8Bytes(SAL + ":" + String(ra).trim()));
}

function hashCodigo(codigo) {
  return ethers.keccak256(ethers.toUtf8Bytes(codigo));
}

/** Espera o blockchain publicar /shared/contrato.json e conecta. */
async function conectar(tentativas = 90) {
  for (let i = 0; i < tentativas; i++) {
    try {
      if (fs.existsSync(CONTRATO_INFO)) {
        info = JSON.parse(fs.readFileSync(CONTRATO_INFO, "utf8"));
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        await provider.getBlockNumber();
        // NonceManager: serializa os nonces das transações do relayer,
        // evitando colisão quando várias ações chegam em sequência.
        const wallet = new ethers.NonceManager(new ethers.Wallet(process.env.PRIVATE_KEY, provider));
        contrato = new ethers.Contract(info.endereco, info.abi, wallet);
        console.log(`[backend] conectado ao contrato ${info.endereco} via ${RPC_URL}`);
        return;
      }
    } catch {
      /* nó ainda subindo — tenta de novo */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`contrato não disponível (${CONTRATO_INFO} / ${RPC_URL})`);
}

function getContrato() {
  if (!contrato) throw new Error("contrato ainda não conectado");
  return contrato;
}

function getInfo() {
  return info;
}

module.exports = { conectar, getContrato, getInfo, alunoId, hashCodigo };
