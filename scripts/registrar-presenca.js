// MÓDULO 2 — Professor valida a presença de uma aula (oráculo humano).
// Uso: CURSO_ID=1 AULA=3 RAS="2311600029,2311600030" \
//   npx hardhat run scripts/registrar-presenca.js --network sepolia
// (ou PRESENCA_CSV=aula3.csv com coluna "ra")
const { alunoId, contrato, lerCsv } = require("./lib");

async function main() {
  const cursoId = process.env.CURSO_ID || "1";
  const aula = process.env.AULA;
  if (!aula) throw new Error("Defina AULA=n");
  let ras = [];
  if (process.env.RAS) ras = process.env.RAS.split(",");
  else if (process.env.PRESENCA_CSV) ras = lerCsv(process.env.PRESENCA_CSV).map(l => l["ra"]).filter(Boolean);
  else throw new Error("Defina RAS=... ou PRESENCA_CSV=arquivo.csv");

  const c = await contrato();
  const tx = await c.registrarPresenca(cursoId, aula, ras.map(alunoId));
  const rc = await tx.wait();
  console.log(`✅ Aula ${aula}: presença registrada para ${ras.length} alunos. Gas: ${rc.gasUsed}`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
