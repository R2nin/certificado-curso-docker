// MÓDULO 3 — "Urna" de avaliação: envia a nota do aluno usando o código secreto.
// Uso: CURSO_ID=1 NOTA=5 CODIGO=AVAL-xxxxxx COMENTARIO="Otimo curso" \
//   npx hardhat run scripts/avaliar.js --network sepolia
const { contrato } = require("./lib");

async function main() {
  const cursoId = process.env.CURSO_ID || "1";
  const nota = process.env.NOTA, codigo = process.env.CODIGO;
  if (!nota || !codigo) throw new Error("Defina NOTA=1..5 e CODIGO=AVAL-...");
  const c = await contrato();
  const tx = await c.avaliar(cursoId, nota, process.env.COMENTARIO || "", codigo);
  await tx.wait();
  const [mediaX100, qtdA] = await c.mediaAvaliacao(cursoId);
  console.log(`✅ Avaliação registrada. Média atual: ${(Number(mediaX100) / 100).toFixed(2)} (${qtdA} votos)`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
