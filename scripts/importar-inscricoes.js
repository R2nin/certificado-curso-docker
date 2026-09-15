// MÓDULO 1 — Importa inscrições do Google Forms para o contrato.
// No Forms: Respostas > exportar .csv (colunas esperadas: nome, e-mail, ra — os títulos
// das perguntas devem conter essas palavras). Uso:
//   npx hardhat run scripts/importar-inscricoes.js --network sepolia
// Variáveis: CONTRATO, CURSO_ID, CSV (caminho do arquivo exportado)
const { alunoId, carregarDados, salvarDados, contrato, lerCsv } = require("./lib");

async function main() {
  const cursoId = process.env.CURSO_ID || "1";
  const csv = process.env.CSV || "inscricoes.csv";
  const c = await contrato();
  const linhas = lerCsv(csv);

  const dados = carregarDados();
  const ids = [];
  for (const l of linhas) {
    const ra = l["ra"] || l[Object.keys(l).find(k => k.includes("ra"))];
    if (!ra) continue;
    const idA = alunoId(ra);
    ids.push(idA);
    dados.alunos[ra] = { alunoId: idA, nome: l["nome"] || "", email: l["e-mail"] || l["email"] || "" };
  }
  salvarDados(dados);
  console.log(`Inscrevendo ${ids.length} alunos no curso ${cursoId}...`);
  const tx = await c.inscreverLote(cursoId, ids);
  const rc = await tx.wait();
  console.log(`✅ Inscritos. Gas: ${rc.gasUsed}. Total no curso: ${await c.totalInscritos(cursoId)}`);
  console.log("Mapa RA->dados salvo OFF-CHAIN em dados-locais.json (não commitar).");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
