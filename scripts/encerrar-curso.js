// MÓDULO 2 — Encerra o curso: o CONTRATO auto-emite os certificados de quem
// atingiu a frequência mínima. Uso:
//   CURSO_ID=1 npx hardhat run scripts/encerrar-curso.js --network sepolia
const { contrato, carregarDados } = require("./lib");

async function main() {
  const cursoId = process.env.CURSO_ID || "1";
  const c = await contrato();
  const tx = await c.encerrarCurso(cursoId);
  const rc = await tx.wait();
  console.log(`Curso ${cursoId} encerrado. Gas: ${rc.gasUsed}\nCertificados auto-emitidos:`);

  const dados = carregarDados();
  const porId = Object.fromEntries(Object.entries(dados.alunos).map(([ra, d]) => [d.alunoId, { ra, ...d }]));
  for (const log of rc.logs) {
    let ev; try { ev = c.interface.parseLog(log); } catch { continue; }
    if (ev?.name === "CertificadoEmitido") {
      const a = porId[ev.args.alunoId] || {};
      console.log(`  Cert #${ev.args.certId} — RA ${a.ra || "?"} ${a.nome || ev.args.alunoId} (${ev.args.aulasPresentes} presenças)`);
    }
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
