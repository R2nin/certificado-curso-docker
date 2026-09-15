// Deploy do CertificadoCurso dentro do contêiner blockchain.
// Espera o RPC do nó local responder, faz o deploy e publica
// { endereco, abi, chainId } no volume compartilhado /shared —
// é assim que o backend descobre o contrato sem hardcode.
const fs = require("fs");
const hre = require("hardhat");
const { ethers, artifacts } = hre;

const SAIDA = process.env.CONTRATO_INFO || "/shared/contrato.json";

async function esperarRpc(tentativas = 60) {
  for (let i = 0; i < tentativas; i++) {
    try {
      await ethers.provider.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("RPC do nó Hardhat não respondeu a tempo");
}

async function main() {
  await esperarRpc();

  const F = await ethers.getContractFactory("CertificadoCurso");
  const c = await F.deploy();
  await c.waitForDeployment();
  const endereco = await c.getAddress();

  const art = await artifacts.readArtifact("CertificadoCurso");
  const rede = await ethers.provider.getNetwork();

  fs.writeFileSync(
    SAIDA,
    JSON.stringify(
      { endereco, chainId: Number(rede.chainId), abi: art.abi, deployEm: new Date().toISOString() },
      null,
      2
    )
  );
  console.log(`[blockchain] CertificadoCurso implantado em ${endereco} (info em ${SAIDA})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
