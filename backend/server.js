// =============================================================================
// API do CertificadoCurso (contêiner backend)
//
// Papel: RELAYER + camada off-chain.
//   - Dados pessoais (RA -> nome/e-mail) ficam no PostgreSQL (LGPD);
//   - Só IDs anônimos (keccak256) e regras vão ao contrato na blockchain;
//   - O professor opera tudo pela página (contêiner frontend), que fala
//     com esta API via proxy do nginx.
// =============================================================================
const express    = require("express");
const path       = require("path");
const fs         = require("fs");
const PDFDocument = require("pdfkit");
const { pool, esperarBanco } = require("./db");
const chain      = require("./chain");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || "http://localhost:8080").replace(/\/$/, "");

// ------------------------------------------------------------------ helpers
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    const msg = decodificarErro(e);
    console.error(`[backend] ${req.method} ${req.path} ->`, msg);
    res.status(400).json({ erro: msg });
  });

/** Traduz custom errors do contrato para mensagens legíveis. */
function decodificarErro(e) {
  const mapa = {
    CursoInexistente: "curso inexistente",
    CursoInativo: "curso inativo",
    CursoJaEncerrado: "curso já encerrado",
    CursoNaoEncerrado: "o curso precisa ser encerrado antes",
    AulaInvalida: "número de aula inválido",
    CertificadoInexistente: "certificado inexistente",
    CodigoInvalido: "código de avaliação inválido",
    CodigoJaUtilizado: "código de avaliação já utilizado",
    NotaInvalida: "nota deve ser de 1 a 5",
  };
  let texto = String(e?.shortMessage || e?.message || e);
  const dados = e?.data || e?.info?.error?.data;
  if (dados) {
    try { texto = chain.getContrato().interface.parseError(dados)?.name || texto; } catch { /* segue */ }
  }
  for (const [nome, msg] of Object.entries(mapa)) if (texto.includes(nome)) return msg;
  return texto.length > 300 ? texto.slice(0, 300) + "..." : texto;
}

async function lerCurso(cursoId) {
  const c = await chain.getContrato().cursos(cursoId);
  if (!c.nome) return null;
  return {
    id: Number(cursoId),
    nome: c.nome,
    cargaHoraria: Number(c.cargaHoraria),
    totalAulas: Number(c.totalAulas),
    presencaMinimaPct: Number(c.presencaMinimaPct),
    ativo: c.ativo,
    encerrado: c.encerrado,
  };
}

/** Converte número de horas para texto em português (ex: "2 (duas) horas"). */
function horasExtenso(h) {
  const palavras = { 1:"uma",2:"duas",3:"três",4:"quatro",5:"cinco",
    6:"seis",7:"sete",8:"oito",9:"nove",10:"dez" };
  const p = palavras[h];
  return p ? `${h} (${p}) hora${h > 1 ? "s" : ""}` : `${h} horas`;
}

// -------------------------------------------------------------------- rotas

/** Saúde dos 3 vizinhos de rede: banco e blockchain. */
app.get("/api/health", wrap(async (_req, res) => {
  await pool.query("SELECT 1");
  const bloco = await chain.getContrato().runner.provider.getBlockNumber();
  res.json({ ok: true, banco: "ok", blockchain: `bloco ${bloco}`, contrato: chain.getInfo().endereco });
}));

/** Informações do ambiente (mostradas no rodapé da página). */
app.get("/api/info", wrap(async (_req, res) => {
  const i = chain.getInfo();
  res.json({ contrato: i.endereco, chainId: i.chainId, deployEm: i.deployEm });
}));

/** Cria curso (transação on-chain, onlyOwner). */
app.post("/api/cursos", wrap(async (req, res) => {
  const { nome, cargaHoraria, totalAulas, presencaMinimaPct, dataRealizacao, instrutor } = req.body;
  if (!nome) throw new Error("informe o nome do curso");
  const tx = await chain.getContrato().criarCurso(nome, cargaHoraria, totalAulas, presencaMinimaPct);
  const rc = await tx.wait();
  const ev = rc.logs.map((l) => { try { return chain.getContrato().interface.parseLog(l); } catch { return null; } })
    .find((p) => p?.name === "CursoCriado");
  const cursoId = Number(ev.args.cursoId);

  // Salva config off-chain (data de realização + instrutor) para o PDF
  if (dataRealizacao || instrutor) {
    await pool.query(
      `INSERT INTO cursos_config (curso_id, data_realizacao, instrutor)
       VALUES ($1, $2, $3)
       ON CONFLICT (curso_id) DO UPDATE
         SET data_realizacao = EXCLUDED.data_realizacao,
             instrutor = EXCLUDED.instrutor`,
      [cursoId, dataRealizacao || null, instrutor?.trim() || null]
    );
  }

  res.status(201).json({ cursoId, txHash: rc.hash });
}));

/** Lista cursos lendo o mapping público até encontrar vazio. */
app.get("/api/cursos", wrap(async (_req, res) => {
  const cursos = [];
  for (let id = 1; id < 1000; id++) {
    const c = await lerCurso(id);
    if (!c) break;
    cursos.push(c);
  }
  res.json(cursos);
}));

/** Detalhe de um curso + nº de inscritos + média de avaliação + config. */
app.get("/api/cursos/:id", wrap(async (req, res) => {
  const c = await lerCurso(req.params.id);
  if (!c) return res.status(404).json({ erro: "curso inexistente" });
  const contrato = chain.getContrato();
  c.totalInscritos = Number(await contrato.totalInscritos(c.id));
  const [mediaX100, qtd] = await contrato.mediaAvaliacao(c.id);
  c.avaliacao = { media: Number(mediaX100) / 100, votos: Number(qtd) };

  // Config off-chain
  const { rows } = await pool.query(
    "SELECT to_char(data_realizacao, 'DD/MM/YYYY') AS data_realizacao, instrutor FROM cursos_config WHERE curso_id = $1",
    [c.id]
  );
  if (rows[0]) { c.dataRealizacao = rows[0].data_realizacao; c.instrutor = rows[0].instrutor; }

  res.json(c);
}));

/**
 * Inscreve alunos: dados pessoais -> PostgreSQL; IDs anônimos -> contrato.
 * Body: { alunos: [{ ra, nome, email? }, ...] }  (import do CSV do Google Forms)
 */
app.post("/api/cursos/:id/alunos", wrap(async (req, res) => {
  const cursoId = Number(req.params.id);
  const alunos = (req.body.alunos || []).filter((a) => a.ra && a.nome);
  if (!alunos.length) throw new Error("nenhum aluno válido (campos ra e nome são obrigatórios)");

  const ids = [];
  for (const a of alunos) {
    const id = chain.alunoId(a.ra);
    ids.push(id);
    await pool.query(
      `INSERT INTO alunos (curso_id, ra, nome, email, aluno_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (curso_id, ra) DO UPDATE SET nome = EXCLUDED.nome, email = EXCLUDED.email`,
      [cursoId, String(a.ra).trim(), a.nome.trim(), a.email?.trim() || null, id]
    );
  }
  const tx = await chain.getContrato().inscreverLote(cursoId, ids);
  const rc = await tx.wait();
  res.status(201).json({ inscritos: alunos.length, txHash: rc.hash });
}));

/** Lista os alunos do curso (banco) com presenças (contrato). */
app.get("/api/cursos/:id/alunos", wrap(async (req, res) => {
  const cursoId = Number(req.params.id);
  const { rows } = await pool.query(
    "SELECT ra, nome, email, aluno_id FROM alunos WHERE curso_id = $1 ORDER BY nome",
    [cursoId]
  );
  const contrato = chain.getContrato();
  const saida = [];
  for (const r of rows) {
    const p = await contrato.presencas(cursoId, r.aluno_id);
    const certId = await contrato.certificadoDe(cursoId, r.aluno_id);
    saida.push({ ...r, presencas: Number(p), certId: Number(certId) || null });
  }
  res.json(saida);
}));

/** Presença de uma aula (professor = oráculo). Body: { aula, ras: [] } */
app.post("/api/cursos/:id/presencas", wrap(async (req, res) => {
  const cursoId = Number(req.params.id);
  const { aula, ras } = req.body;
  if (!aula || !Array.isArray(ras) || !ras.length) throw new Error("informe aula e a lista de RAs presentes");
  const ids = ras.map(chain.alunoId);
  const tx = await chain.getContrato().registrarPresenca(cursoId, aula, ids);
  const rc = await tx.wait();
  res.json({ aula, registrados: ras.length, txHash: rc.hash });
}));

/** Encerra o curso — o CONTRATO auto-emite os certificados. */
app.post("/api/cursos/:id/encerrar", wrap(async (req, res) => {
  const cursoId = Number(req.params.id);
  const contrato = chain.getContrato();
  const tx = await contrato.encerrarCurso(cursoId);
  const rc = await tx.wait();
  const emitidos = rc.logs
    .map((l) => { try { return contrato.interface.parseLog(l); } catch { return null; } })
    .filter((p) => p?.name === "CertificadoEmitido")
    .map((p) => ({ certId: Number(p.args.certId), alunoId: p.args.alunoId, aulasPresentes: Number(p.args.aulasPresentes) }));

  for (const cert of emitidos) {
    const { rows } = await pool.query(
      "SELECT ra, nome FROM alunos WHERE curso_id = $1 AND aluno_id = $2", [cursoId, cert.alunoId]
    );
    Object.assign(cert, rows[0] || {});
  }
  res.json({ certificadosEmitidos: emitidos.length, certificados: emitidos, txHash: rc.hash });
}));

/** Certificados do curso (junção banco + contrato). */
app.get("/api/cursos/:id/certificados", wrap(async (req, res) => {
  const cursoId = Number(req.params.id);
  const { rows } = await pool.query(
    "SELECT ra, nome, aluno_id FROM alunos WHERE curso_id = $1 ORDER BY nome", [cursoId]
  );
  const contrato = chain.getContrato();
  const certs = [];
  for (const r of rows) {
    const certId = Number(await contrato.certificadoDe(cursoId, r.aluno_id));
    if (!certId) continue;
    const c = await contrato.certificados(certId);
    certs.push({
      certId, ra: r.ra, nome: r.nome, alunoId: r.aluno_id,
      aulasPresentes: Number(c.aulasPresentes),
      dataEmissao: new Date(Number(c.dataEmissao) * 1000).toISOString(),
      revogado: c.revogado,
    });
  }
  res.json(certs);
}));

/**
 * Gera códigos secretos de avaliação (1 por certificado, por padrão),
 * guarda no banco (para o professor imprimir) e registra os HASHES on-chain.
 */
app.post("/api/cursos/:id/avaliacoes/habilitar", wrap(async (req, res) => {
  const cursoId = Number(req.params.id);
  let qtd = Number(req.body.quantidade) || 0;
  const contrato = chain.getContrato();
  if (!qtd) {
    const { rows } = await pool.query("SELECT aluno_id FROM alunos WHERE curso_id = $1", [cursoId]);
    for (const r of rows) if (Number(await contrato.certificadoDe(cursoId, r.aluno_id))) qtd++;
    if (!qtd) throw new Error("nenhum certificado emitido — encerre o curso antes");
  }
  const { randomBytes } = require("crypto");
  const codigos = [];
  for (let i = 0; i < qtd; i++) codigos.push("AVAL-" + randomBytes(4).toString("hex"));
  const hashes = codigos.map(chain.hashCodigo);

  const tx = await contrato.habilitarAvaliacao(cursoId, hashes);
  await tx.wait();
  for (let i = 0; i < codigos.length; i++)
    await pool.query(
      "INSERT INTO codigos_avaliacao (curso_id, codigo, hash) VALUES ($1,$2,$3)",
      [cursoId, codigos[i], hashes[i]]
    );
  res.status(201).json({ quantidade: qtd, codigos: codigos.sort(() => Math.random() - 0.5) });
}));

/** "Urna": registra a avaliação anônima. Body: { nota, comentario?, codigo } */
app.post("/api/cursos/:id/avaliacoes", wrap(async (req, res) => {
  const cursoId = Number(req.params.id);
  const { nota, comentario, codigo } = req.body;
  if (!codigo) throw new Error("informe o código secreto");
  const tx = await chain.getContrato().avaliar(cursoId, Number(nota), comentario || "", codigo.trim());
  const rc = await tx.wait();
  const [mediaX100, qtd] = await chain.getContrato().mediaAvaliacao(cursoId);
  res.status(201).json({ txHash: rc.hash, hashCodigo: chain.hashCodigo(codigo.trim()),
    media: Number(mediaX100) / 100, votos: Number(qtd) });
}));

/** Verificação pública de um certificado pelo número impresso. */
app.get("/api/certificados/:certId", wrap(async (req, res) => {
  const r = await chain.getContrato().verificarCertificado(req.params.certId);
  res.json({
    certId: Number(req.params.certId),
    valido: r.valido, alunoId: r.alunoId, nomeCurso: r.nomeCurso,
    cargaHoraria: Number(r.cargaHoraria), aulasPresentes: Number(r.aulasPresentes),
    totalAulas: Number(r.totalAulas),
    dataEmissao: new Date(Number(r.dataEmissao) * 1000).toISOString(),
  });
}));

/**
 * Gera o PDF do certificado com layout fiel ao modelo FEMA.
 * Coordenadas extraídas do PPTX, escaladas para A4 paisagem (841.89×595.28pt).
 * Inclui QR code do link de verificação no rodapé.
 */
app.get("/api/certificados/:certId/pdf", wrap(async (req, res) => {
  const certId = Number(req.params.certId);
  const contrato = chain.getContrato();

  // Dados on-chain
  const cert = await contrato.certificados(certId);
  const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
  if (cert.alunoId === ZERO) return res.status(404).json({ erro: "certificado inexistente" });
  if (cert.revogado)         return res.status(400).json({ erro: "certificado revogado" });

  const cursoId = Number(cert.cursoId);
  const curso   = await contrato.cursos(cursoId);

  // Nome do aluno (off-chain, LGPD)
  const { rows: alunoRows } = await pool.query(
    "SELECT nome FROM alunos WHERE aluno_id = $1 LIMIT 1", [cert.alunoId]
  );
  const nomeAluno = alunoRows[0]?.nome || "Participante";

  // Config do curso: data de realização e instrutor
  const { rows: cfgRows } = await pool.query(
    "SELECT to_char(data_realizacao, 'DD/MM/YYYY') AS data, instrutor FROM cursos_config WHERE curso_id = $1",
    [cursoId]
  );
  const dataRealizacao = cfgRows[0]?.data ||
    new Date(Number(cert.dataEmissao) * 1000).toLocaleDateString("pt-BR");
  const instrutor = cfgRows[0]?.instrutor || "";

  const cargaHoraria = Number(curso.cargaHoraria);
  const horasStr      = horasExtenso(cargaHoraria);
  const urlVerificacao = `${BASE_URL}/#verificar/${certId}`;

  // Gera QR code em buffer PNG
  const QRCode  = require("qrcode");
  const qrBuffer = await QRCode.toBuffer(urlVerificacao, { type: "png", width: 180, margin: 1 });

  // ── PDF (A4 paisagem: 841.89 × 595.28 pt) ────────────────────────────────
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 0, compress: true });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="certificado-${certId}.pdf"`);
  doc.pipe(res);

  const BLUE = "#004784", ORANGE = "#D68500", DARK = "#231F20", GRAY = "#5C6672", WHITE = "#ffffff";
  const W = doc.page.width, H = doc.page.height;

  // Cores primária/secundária — alternam a cada certificado (ímpar=azul, par=laranja)
  const [C1, C2] = certId % 2 === 0 ? [ORANGE, BLUE] : [BLUE, ORANGE];

  // ── 1. Fundo branco ───────────────────────────────────────────────────────
  doc.rect(0, 0, W, H).fill(WHITE);

  // ── 2. Decorações — todos retângulos fiéis ao PPTX (escalados para A4) ───
  // Lado esquerdo: retângulo alto C1 + quadrado C2 sobrepostos
  doc.rect(-30.69, 38.58, 116.64, 218.27).lineWidth(3.508).strokeColor(C1).stroke();
  doc.rect(17.54, 137.80, 94.71, 94.71).lineWidth(3.508).strokeColor(C2).stroke();

  // Lado direito: retângulo alto C2 + quadrado C1 sobrepostos
  doc.rect(744.55, 165.36, 125.41, 240.32).lineWidth(3.508).strokeColor(C2).stroke();
  doc.rect(734.02, 242.52, 88.57, 88.57).lineWidth(3.508).strokeColor(C1).stroke();

  // Quadrados com gradiente de opacidade nos cantos opostos (PPTX shapes 4/5)
  // Canto superior direito — C1, fade da direita para esquerda
  {
    const gx = 731.39, gy = 30.87, gs = 70.16;
    const g = doc.linearGradient(gx + gs, gy, gx, gy + gs);
    g.stop(0, C1, 0.45).stop(1, C1, 0);
    doc.rect(gx, gy, gs, gs).fill(g);
  }
  // Canto inferior esquerdo — C2, fade da esquerda para direita
  {
    const gx = 40.34, gy = 385.83, gs = 70.16;
    const g = doc.linearGradient(gx, gy + gs, gx + gs, gy);
    g.stop(0, C2, 0.45).stop(1, C2, 0);
    doc.rect(gx, gy, gs, gs).fill(g);
  }

  // ── 3. Rodapé (desenhado cedo — conteúdo fica por cima) ──────────────────
  const footY = 512.6, footH = 82.68;
  doc.rect(0, footY, W, footH).fill(C1);

  // ── 4. Logo FEMA ──────────────────────────────────────────────────────────
  const logoPath = path.join(__dirname, "assets", "logo-fema.png");
  if (fs.existsSync(logoPath)) {
    doc.image(fs.readFileSync(logoPath), 320.09, 38.58, { width: 201.7 });
  }

  // ── 5. Textos do certificado ───────────────────────────────────────────────
  // "CURRICULARIZAÇÃO DA EXTENSÃO" — PPTX 19.5pt × SY = 14.33pt
  doc.font("Helvetica-Bold").fontSize(14.33).fillColor(ORANGE)
     .text("CURRICULARIZAÇÃO DA EXTENSÃO", 248.61, 136.87,
           { width: 344.66, align: "center", characterSpacing: 1.5 });

  // "CERTIFICADO" — PPTX 78pt × SY = 57.32pt
  doc.font("Helvetica-Bold").fontSize(57.32).fillColor(BLUE)
     .text("CERTIFICADO", 213.69, 160.9, { width: 414.5, align: "center" });

  // Barras laranja + nome do curso — PPTX 36pt × SY = 26.46pt
  doc.rect(198.72, 248.32, 48.23, 3.31).fill(C2);
  doc.font("Helvetica-Bold").fontSize(26.46).fillColor(DARK)
     .text(curso.nome, 244.02, 234.76, { width: 353.85, align: "center" });
  doc.rect(594.94, 248.32, 48.23, 3.31).fill(C2);

  // "A Fundação… certifica que" — PPTX 22.5pt × SY = 16.54pt
  doc.font("Helvetica").fontSize(16.54).fillColor(DARK)
     .text("A Fundação Educacional do Município de Assis certifica que",
           240.18, 286.13, { width: 361.53, align: "center" });

  // Nome do aluno — PPTX 43.5pt × SY = 31.97pt
  doc.font("Helvetica-Bold").fontSize(31.97).fillColor(BLUE)
     .text(nomeAluno, 249.74, 325.26, { width: 342.41, align: "center" });

  // Corpo do texto (2 linhas) — PPTX 22.5pt × SY = 16.54pt
  // Linha 1: alinhamento uniforme
  // Linha 2: partes bold/normal centralizadas manualmente via widthOfString
  const bx = 122.86, bw = 596.16, bfs = 16.54, centroX = bx + bw / 2;

  doc.font("Helvetica").fontSize(bfs).fillColor(DARK)
     .text(
       "participou do curso de extensão acima descrito, no âmbito da Curricularização da Extensão,",
       bx, 377.95, { width: bw, align: "center" }
     );

  const partes = [
    { t: "com carga horária total de ", f: "Helvetica"      },
    { t: horasStr,                      f: "Helvetica-Bold" },
    { t: ", realizado em ",             f: "Helvetica"      },
    { t: dataRealizacao,                f: "Helvetica-Bold" },
    { t: ".",                           f: "Helvetica"      },
  ];
  let larguraTotal = 0;
  for (const p of partes) { doc.font(p.f).fontSize(bfs); larguraTotal += doc.widthOfString(p.t); }
  let partX = centroX - larguraTotal / 2;
  const partY = doc.y + 2;
  for (const p of partes) {
    doc.font(p.f).fontSize(bfs).fillColor(DARK).text(p.t, partX, partY, { lineBreak: false });
    doc.font(p.f).fontSize(bfs);
    partX += doc.widthOfString(p.t);
  }

  // ── 6. Assinatura (desenhada após o rodapé, fica por cima) ───────────────
  doc.moveTo(280.63, 468.35).lineTo(561.26, 468.35).lineWidth(1).strokeColor(DARK).stroke();

  // Nome do instrutor — PPTX 21pt × SY = 15.43pt
  const nomeInstrutor = instrutor || "Alex Sandro Romeo de Souza Poletto";
  doc.font("Helvetica-Bold").fontSize(15.43).fillColor(DARK)
     .text(nomeInstrutor, 276.42, 476.95, { width: 289.05, align: "center" });

  // Cargo — PPTX 19.5pt × SY = 14.33pt
  doc.font("Helvetica").fontSize(14.33).fillColor(GRAY)
     .text("Coordenador do curso de Computação \u2013 FEMA",
           266.6, 497.89, { width: 308.69, align: "center" });

  // ── 7. Conteúdo do rodapé (por cima da faixa já desenhada) ───────────────
  // Endereço — PPTX 18pt × SY = 13.23pt
  doc.font("Helvetica").fontSize(13.23).fillColor(WHITE)
     .text("Fundação Educacional do Município de Assis", 39.46, 532.63, { width: 250 });
  doc.font("Helvetica").fontSize(13.23).fillColor(WHITE)
     .text("Av. Getúlio Vargas, 1200 \u2013 Assis/SP",  39.46, 549,    { width: 250 });

  // QR code — canto direito do rodapé
  const qrSize = 62;
  const qrX = W - 39.46 - qrSize;
  const qrY = footY + (footH - qrSize) / 2;
  doc.image(qrBuffer, qrX, qrY, { width: qrSize });

  // Cert nº + link
  const txtX = 546.34, txtW = qrX - txtX - 6;
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(WHITE)
     .text(`Certificado n\u00ba ${certId}`, txtX, 528,   { width: txtW, align: "right" });
  doc.font("Helvetica").fontSize(8).fillColor(WHITE)
     .text("Verifique a autenticidade:",    txtX, 541.5, { width: txtW, align: "right" });
  doc.font("Helvetica").fontSize(7.5).fillColor(WHITE)
     .text(urlVerificacao, txtX, 553, {
       width: txtW, align: "right", link: urlVerificacao, underline: true
     });

  doc.end();
}));

// ------------------------------------------------------------------ startup
(async () => {
  await esperarBanco();

  // Migração: cria tabela de config se não existir (idempotente)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cursos_config (
      curso_id        BIGINT PRIMARY KEY,
      data_realizacao DATE,
      instrutor       TEXT
    )
  `);

  await chain.conectar();
  app.listen(PORT, () => console.log(`[backend] API ouvindo na porta ${PORT}`));
})().catch((e) => {
  console.error("[backend] falha na inicialização:", e.message);
  process.exit(1);
});
