const { expect } = require("chai");
const { ethers } = require("hardhat");

// ID anônimo do aluno = keccak256(SAL + RA) — igual ao usado nos scripts
const SAL = "curso-fema-2026";
const id = (ra) => ethers.keccak256(ethers.toUtf8Bytes(SAL + ":" + ra));
const hashCod = (c) => ethers.keccak256(ethers.toUtf8Bytes(c));

describe("CertificadoCurso v2 (sem carteiras de alunos)", function () {
  let contrato, dono, relayer;
  const A1 = id("2311600029"), A2 = id("2311600030"), A3 = id("2311600031");

  beforeEach(async function () {
    [dono, relayer] = await ethers.getSigners();
    const F = await ethers.getContractFactory("CertificadoCurso");
    contrato = await F.deploy();
    await contrato.waitForDeployment();
    // Curso: 4 aulas, presença mínima 75% (= 3 aulas)
    await contrato.criarCurso("Introducao a Blockchain", 20, 4, 75);
  });

  async function cursoCompleto() {
    await contrato.inscreverLote(1, [A1, A2, A3]);
    // A1 presente nas 4 aulas; A2 em 3; A3 em 2 (reprova por frequência)
    await contrato.registrarPresenca(1, 1, [A1, A2, A3]);
    await contrato.registrarPresenca(1, 2, [A1, A2, A3]);
    await contrato.registrarPresenca(1, 3, [A1, A2]);
    await contrato.registrarPresenca(1, 4, [A1]);
  }

  describe("Módulo 1 — Inscrições (import do Google Forms)", function () {
    it("inscreve em lote, ignora duplicatas e conta inscritos", async function () {
      await contrato.inscreverLote(1, [A1, A2, A2]);
      expect(await contrato.totalInscritos(1)).to.equal(2);
      expect(await contrato.inscritos(1, A1)).to.equal(true);
    });
    it("somente o dono inscreve", async function () {
      await expect(contrato.connect(relayer).inscreverLote(1, [A1]))
        .to.be.revertedWithCustomError(contrato, "OwnableUnauthorizedAccount");
    });
  });

  describe("Módulo 2 — Presença e auto-emissão", function () {
    it("não conta presença duplicada na mesma aula nem de não inscrito", async function () {
      await contrato.inscreverLote(1, [A1]);
      await contrato.registrarPresenca(1, 1, [A1, A1, A2]); // A2 não inscrito
      expect(await contrato.presencas(1, A1)).to.equal(1);
      expect(await contrato.presencas(1, A2)).to.equal(0);
    });
    it("rejeita aula fora do intervalo", async function () {
      await contrato.inscreverLote(1, [A1]);
      await expect(contrato.registrarPresenca(1, 5, [A1]))
        .to.be.revertedWithCustomError(contrato, "AulaInvalida");
    });
    it("AUTO-EXECUTA a emissão no encerramento: só quem atingiu 75%", async function () {
      await cursoCompleto();
      await expect(contrato.encerrarCurso(1))
        .to.emit(contrato, "CursoEncerrado").withArgs(1, 2); // A1 e A2

      const [certA1] = await contrato.verificarPorAluno(1, A1);
      const [certA2] = await contrato.verificarPorAluno(1, A2);
      expect(certA1).to.equal(1);
      expect(certA2).to.equal(2);
      await expect(contrato.verificarPorAluno(1, A3))
        .to.be.revertedWithCustomError(contrato, "CertificadoInexistente"); // 2/4 = 50% < 75%
    });
    it("bloqueia presenças após encerramento", async function () {
      await cursoCompleto();
      await contrato.encerrarCurso(1);
      await expect(contrato.registrarPresenca(1, 4, [A2]))
        .to.be.revertedWithCustomError(contrato, "CursoJaEncerrado");
    });
    it("verificação pública retorna dados do certificado", async function () {
      await cursoCompleto();
      await contrato.encerrarCurso(1);
      const v = await contrato.connect(relayer).verificarCertificado(1);
      expect(v.valido).to.equal(true);
      expect(v.alunoId).to.equal(A1);
      expect(v.nomeCurso).to.equal("Introducao a Blockchain");
      expect(v.aulasPresentes).to.equal(4);
    });
    it("revogação invalida o certificado", async function () {
      await cursoCompleto();
      await contrato.encerrarCurso(1);
      await contrato.revogarCertificado(1, "erro administrativo");
      const v = await contrato.verificarCertificado(1);
      expect(v.valido).to.equal(false);
    });
  });

  describe("Módulo 3 — Avaliação on-chain anônima por código", function () {
    const C1 = "AVAL-7f3k9q", C2 = "AVAL-2m8x1z";

    beforeEach(async function () {
      await cursoCompleto();
    });

    it("só habilita após encerramento", async function () {
      await expect(contrato.habilitarAvaliacao(1, [hashCod(C1)]))
        .to.be.revertedWithCustomError(contrato, "CursoNaoEncerrado");
    });

    it("registra avaliação com código válido, via relayer, e calcula média", async function () {
      await contrato.encerrarCurso(1);
      await contrato.habilitarAvaliacao(1, [hashCod(C1), hashCod(C2)]);

      await expect(contrato.connect(relayer).avaliar(1, 5, "Otimo curso", C1))
        .to.emit(contrato, "AvaliacaoRegistrada").withArgs(1, hashCod(C1), 5, "Otimo curso");
      await contrato.connect(relayer).avaliar(1, 4, "", C2);

      const [mediaX100, qtd] = await contrato.mediaAvaliacao(1);
      expect(qtd).to.equal(2);
      expect(mediaX100).to.equal(450); // (5+4)/2 = 4,50
    });

    it("rejeita código inválido, reuso e nota fora de 1-5", async function () {
      await contrato.encerrarCurso(1);
      await contrato.habilitarAvaliacao(1, [hashCod(C1)]);

      await expect(contrato.connect(relayer).avaliar(1, 5, "", "codigo-falso"))
        .to.be.revertedWithCustomError(contrato, "CodigoInvalido");
      await contrato.connect(relayer).avaliar(1, 3, "", C1);
      await expect(contrato.connect(relayer).avaliar(1, 5, "", C1))
        .to.be.revertedWithCustomError(contrato, "CodigoJaUtilizado");
      await expect(contrato.connect(relayer).avaliar(1, 6, "", C1))
        .to.be.revertedWithCustomError(contrato, "NotaInvalida");
    });
  });

  describe("Medição de gas (dados para o TCC)", function () {
    it("mede as operações do fluxo completo", async function () {
      const custos = {};
      let tx, rc;
      tx = await contrato.inscreverLote(1, [A1, A2, A3]); rc = await tx.wait();
      custos["inscreverLote (3 alunos)"] = rc.gasUsed;
      tx = await contrato.registrarPresenca(1, 1, [A1, A2, A3]); rc = await tx.wait();
      custos["registrarPresenca (3)"] = rc.gasUsed;
      await contrato.registrarPresenca(1, 2, [A1, A2, A3]);
      await contrato.registrarPresenca(1, 3, [A1, A2, A3]);
      tx = await contrato.encerrarCurso(1); rc = await tx.wait();
      custos["encerrarCurso (3 certs)"] = rc.gasUsed;
      tx = await contrato.habilitarAvaliacao(1, [hashCod("c1"), hashCod("c2"), hashCod("c3")]); rc = await tx.wait();
      custos["habilitarAvaliacao (3)"] = rc.gasUsed;
      tx = await contrato.avaliar(1, 5, "", "c1"); rc = await tx.wait();
      custos["avaliar"] = rc.gasUsed;

      console.log("\n      Custos de gas medidos:");
      for (const [op, gas] of Object.entries(custos))
        console.log(`        ${op.padEnd(26)} ${gas.toString().padStart(8)} gas`);
      expect(custos["avaliar"]).to.be.greaterThan(0n);
    });
  });
});
