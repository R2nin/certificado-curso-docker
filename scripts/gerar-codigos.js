// MÓDULO 3 — Gera códigos secretos de avaliação (um por certificado) e os
// habilita no contrato. Distribua um código a cada aluno certificado, de forma
// embaralhada (sem anotar qual foi para quem) => avaliação anônima.
// Uso: CURSO_ID=1 QTD=25 npx hardhat run scripts/gerar-codigos.js --network sepolia
const fs = require("fs");
const crypto = require("crypto");
const { ethers } = require("hardhat");
const { contrato } = require("./lib");

async function main() {
  const cursoId = process.env.CURSO_ID || "1";
  const qtd = parseInt(process.env.QTD || "0");
  if (!qtd) throw new Error("Defina QTD=n (nº de certificados emitidos)");

  const codigos = Array.from({ length: qtd }, () => "AVAL-" + crypto.randomBytes(6).toString("hex"));
  fs.writeFileSync(`codigos-curso-${cursoId}.txt`, codigos.join("\n"));

  const c = await contrato();
  const tx = await c.habilitarAvaliacao(cursoId, codigos.map(x => ethers.keccak256(ethers.toUtf8Bytes(x))));
  const rc = await tx.wait();
  console.log(`✅ ${qtd} códigos habilitados (gas: ${rc.gasUsed}).`);
  console.log(`Códigos salvos em codigos-curso-${cursoId}.txt — imprima, recorte e distribua embaralhados.`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
