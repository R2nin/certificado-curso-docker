// =============================================================================
// API do CertificadoCurso (contêiner backend)
//
// Papel: RELAYER + camada off-chain.
//   - Dados pessoais (RA -> nome/e-mail) ficam no PostgreSQL (LGPD);
//   - Só IDs anônimos (keccak256) e regras vão ao contrato na blockchain;
//   - O professor opera tudo pela página (contêiner frontend), que fala
//     com esta API via proxy do nginx.
// =============================================================================
const express = require("express");
const { pool, esperarBanco } = require("./db");
const chain = require("./chain");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

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
  // custom errors chegam como bytes em e.data — decodifica pela ABI
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
  const { nome, cargaHoraria, totalAulas, presencaMinimaPct } = req.body;
  if (!nome) throw new Error("informe o nome do curso");
  const tx = await chain.getContrato().criarCurso(nome, cargaHoraria, totalAulas, presencaMinimaPct);
  const rc = await tx.wait();
  const ev = rc.logs.map((l) => { try { return chain.getContrato().interface.parseLog(l); } catch { return null; } })
    .find((p) => p?.name === "CursoCriado");
  res.status(201).json({ cursoId: Number(ev.args.cursoId), txHash: rc.hash });
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

/** Detalhe de um curso + nº de inscritos + média de avaliação. */
app.get("/api/cursos/:id", wrap(async (req, res) => {
  const c = await lerCurso(req.params.id);
  if (!c) return res.status(404).json({ erro: "curso inexistente" });
  const contrato = chain.getContrato();
  c.totalInscritos = Number(await contrato.totalInscritos(c.id));
  const [mediaX100, qtd] = await contrato.mediaAvaliacao(c.id);
  c.avaliacao = { media: Number(mediaX100) / 100, votos: Number(qtd) };
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
    // off-chain (LGPD): o mapa RA -> nome fica SÓ no banco do professor
    await pool.query(
      `INSERT INTO alunos (curso_id, ra, nome, email, aluno_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (curso_id, ra) DO UPDATE SET nome = EXCLUDED.nome, email = EXCLUDED.email`,
      [cursoId, String(a.ra).trim(), a.nome.trim(), a.email?.trim() || null, id]
    );
  }
  // on-chain: apenas os hashes
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

  // enriquece com os nomes (off-chain) para o professor imprimir
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
 * Body: { quantidade? }
 */
app.post("/api/cursos/:id/avaliacoes/habilitar", wrap(async (req, res) => {
  const cursoId = Number(req.params.id);
  let qtd = Number(req.body.quantidade) || 0;
  const contrato = chain.getContrato();
  if (!qtd) {
    // padrão: um código por certificado emitido
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
  // devolve embaralhado — nenhuma ordem vincula código a aluno
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

// ------------------------------------------------------------------ startup
(async () => {
  await esperarBanco();     // espera o contêiner db
  await chain.conectar();   // espera o contêiner blockchain publicar o contrato
  app.listen(PORT, () => console.log(`[backend] API ouvindo na porta ${PORT}`));
})().catch((e) => {
  console.error("[backend] falha na inicialização:", e.message);
  process.exit(1);
});
