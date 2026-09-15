// Deploy do contrato + demonstração do fluxo completo em rede local.
// Sepolia: npx hardhat run scripts/deploy.js --network sepolia
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Rede: ${network.name} | Deployer: ${deployer.address}`);

  const F = await ethers.getContractFactory("CertificadoCurso");
  const c = await F.deploy();
  await c.waitForDeployment();
  const endereco = await c.getAddress();
  console.log(`✅ CertificadoCurso implantado em: ${endereco}`);

  if (network.name === "hardhat" || network.name === "localhost") {
    console.log("\n--- Demonstração do fluxo completo ---");
    const id = (ra) => ethers.keccak256(ethers.toUtf8Bytes("curso-fema-2026:" + ra));
    const A = [id("111"), id("222"), id("333")];

    await (await c.criarCurso("Introducao a Blockchain", 20, 4, 75)).wait();
    console.log("1. Curso criado (4 aulas, presença mínima 75%)");
    await (await c.inscreverLote(1, A)).wait();
    console.log("2. 3 alunos inscritos (via import do Google Forms)");
    for (const [aula, presentes] of [[1, A], [2, A], [3, [A[0], A[1]]], [4, [A[0]]]])
      await (await c.registrarPresenca(1, aula, presentes)).wait();
    console.log("3. Presenças das 4 aulas validadas pelo professor");
    const rc = await (await c.encerrarCurso(1)).wait();
    const emitidos = rc.logs.filter(l => { try { return c.interface.parseLog(l)?.name === "CertificadoEmitido"; } catch { return false; } });
    console.log(`4. Curso encerrado → contrato AUTO-EMITIU ${emitidos.length} certificados (aluno 333 tinha 50% < 75%)`);
    const cod = "AVAL-demo1";
    await (await c.habilitarAvaliacao(1, [ethers.keccak256(ethers.toUtf8Bytes(cod))])).wait();
    await (await c.avaliar(1, 5, "Excelente", cod)).wait();
    const [m, q] = await c.mediaAvaliacao(1);
    console.log(`5. Avaliação on-chain registrada. Média: ${(Number(m) / 100).toFixed(2)} (${q} voto)`);
  } else {
    console.log(`\nAdicione ao .env:  CONTRATO=${endereco}`);
    console.log(`Verifique o código: npx hardhat verify --network ${network.name} ${endereco}`);
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
