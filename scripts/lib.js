// Utilitários compartilhados pelos scripts operacionais
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const SAL = process.env.SAL_ALUNOS || "curso-fema-2026"; // defina no .env e NUNCA divulgue
const DADOS = path.join(__dirname, "..", "dados-locais.json"); // mapa off-chain RA -> dados (LGPD: fica só com o professor)

function alunoId(ra) {
  return ethers.keccak256(ethers.toUtf8Bytes(SAL + ":" + String(ra).trim()));
}
function carregarDados() {
  return fs.existsSync(DADOS) ? JSON.parse(fs.readFileSync(DADOS, "utf8")) : { alunos: {} };
}
function salvarDados(d) { fs.writeFileSync(DADOS, JSON.stringify(d, null, 2)); }

async function contrato() {
  const endereco = process.env.CONTRATO;
  if (!endereco) throw new Error("Defina CONTRATO=0x... no .env (endereço do deploy)");
  return ethers.getContractAt("CertificadoCurso", endereco);
}

// Parser simples de CSV do Google Forms (separador vírgula, aspas opcionais)
function lerCsv(caminho) {
  const linhas = fs.readFileSync(caminho, "utf8").split(/\r?\n/).filter(Boolean);
  const cab = linhas[0].split(",").map(c => c.replace(/(^"|"$)/g, "").trim().toLowerCase());
  return linhas.slice(1).map(l => {
    const cols = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(c => c.replace(/,$/, "").replace(/(^"|"$)/g, "").trim());
    const o = {}; cab.forEach((c, i) => o[c] = cols[i] ?? ""); return o;
  });
}
module.exports = { alunoId, carregarDados, salvarDados, contrato, lerCsv, SAL };
