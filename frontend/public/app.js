// Painel do CertificadoCurso — consome a API via /api (proxy do nginx).
// Vanilla JS: fetch + manipulação direta do DOM, sem framework.

const $ = (s) => document.querySelector(s);
const statusEl = $("#status");
let cursoAtivo = null;

// ------------------------------------------------------------------ helpers
function aviso(tipo, msg) {
  statusEl.hidden = false;
  statusEl.className = `status ${tipo}`;
  statusEl.textContent = msg;
  if (tipo !== "load") setTimeout(() => (statusEl.hidden = true), 7000);
}

async function api(caminho, opts = {}) {
  const r = await fetch(`/api${caminho}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || `HTTP ${r.status}`);
  return dados;
}

/** Envolve um submit/click: trava o botão, mostra progresso, trata erro. */
function acao(el, evento, fn) {
  el.addEventListener(evento, async (e) => {
    e.preventDefault();
    const btn = el.matches("button") ? el : el.querySelector("button[type=submit]") || el.querySelector("button");
    if (btn) btn.disabled = true;
    aviso("load", "enviando transação pelos contêineres… (frontend → backend → db/blockchain)");
    try {
      await fn(e);
    } catch (err) {
      aviso("err", `Erro: ${err.message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

const form = (f) => Object.fromEntries(new FormData(f).entries());
const rasDe = (txt) => txt.split(",").map((s) => s.trim()).filter(Boolean);

// ----------------------------------------------------------------- cursos
async function carregarCursos(selecionar) {
  const cursos = await api("/cursos");
  const sel = $("#sel-curso");
  sel.innerHTML = '<option value="">— crie ou selecione —</option>' +
    cursos.map((c) => `<option value="${c.id}">${c.id} · ${c.nome}${c.encerrado ? " (encerrado)" : ""}</option>`).join("");
  if (selecionar) sel.value = selecionar;
  cursoAtivo = Number(sel.value) || null;
  await mostrarCurso();
}

async function mostrarCurso() {
  const info = $("#curso-info");
  if (!cursoAtivo) { info.hidden = true; $("#tab-alunos").innerHTML = ""; $("#tab-certs").innerHTML = ""; return; }
  const c = await api(`/cursos/${cursoAtivo}`);
  info.hidden = false;
  info.innerHTML = `
    <b>Curso</b><span>${c.nome}</span>
    <b>Data de realização</b><span>${c.dataRealizacao || "—"}</span>
    <b>Responsável</b><span>${c.instrutor || "—"}</span>
    <b>Carga / aulas</b><span>${c.cargaHoraria} h · ${c.totalAulas} aulas · mínimo ${c.presencaMinimaPct}%</span>
    <b>Situação</b><span>${c.encerrado ? "encerrado (certificados emitidos)" : c.ativo ? "ativo" : "inativo"}</span>
    <b>Inscritos</b><span>${c.totalInscritos}</span>
    <b>Avaliação</b><span>${c.avaliacao.votos ? `${c.avaliacao.media.toFixed(2)} (${c.avaliacao.votos} votos)` : "sem votos ainda"}</span>`;
  await listarAlunos();
  await listarCertificados();
}

async function listarAlunos() {
  const alunos = cursoAtivo ? await api(`/cursos/${cursoAtivo}/alunos`) : [];
  $("#tab-alunos").innerHTML = !alunos.length ? "" : `
    <table><thead><tr><th>Aluno</th><th>RA</th><th>ID anônimo (on-chain)</th><th>Presenças</th></tr></thead>
    <tbody>${alunos.map((a) => `
      <tr${a.certId ? ' class="cert"' : ""}>
        <td>${a.nome}${a.certId ? ` · cert. nº ${a.certId}` : ""}</td>
        <td class="mono">${a.ra}</td>
        <td class="mono">${a.aluno_id.slice(0, 18)}…</td>
        <td>${a.presencas}</td>
      </tr>`).join("")}
    </tbody></table>`;
}

async function listarCertificados() {
  const certs = cursoAtivo ? await api(`/cursos/${cursoAtivo}/certificados`) : [];
  $("#tab-certs").innerHTML = !certs.length ? "" : `
    <table><thead><tr><th>Nº</th><th>Aluno</th><th>Presenças</th><th>Emitido em</th><th>PDF</th></tr></thead>
    <tbody>${certs.map((c) => `
      <tr><td>${c.certId}</td><td>${c.nome} (${c.ra})</td><td>${c.aulasPresentes}</td>
      <td>${new Date(c.dataEmissao).toLocaleDateString("pt-BR")}</td>
      <td><a href="/api/certificados/${c.certId}/pdf" target="_blank" class="btn-pdf-sm">PDF</a></td>
      </tr>`).join("")}
    </tbody></table>`;
}

// ------------------------------------------------------------------ ações
acao($("#f-curso"), "submit", async (e) => {
  const d = form(e.target);
  const r = await api("/cursos", { method: "POST", body: {
    nome: d.nome, cargaHoraria: +d.cargaHoraria, totalAulas: +d.totalAulas,
    presencaMinimaPct: +d.presencaMinimaPct,
    dataRealizacao: d.dataRealizacao || null,
    instrutor: d.instrutor || null,
  }});
  aviso("ok", `Curso nº ${r.cursoId} criado on-chain (tx ${r.txHash.slice(0, 14)}…)`);
  e.target.reset();
  await carregarCursos(r.cursoId);
});

$("#sel-curso").addEventListener("change", async (e) => {
  cursoAtivo = Number(e.target.value) || null;
  await mostrarCurso().catch((err) => aviso("err", err.message));
});
acao($("#btn-recarregar"), "click", () => carregarCursos($("#sel-curso").value));

acao($("#f-alunos"), "submit", async (e) => {
  if (!cursoAtivo) throw new Error("selecione um curso no passo 1");
  const linhas = form(e.target).csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const alunos = linhas.map((l) => {
    const [nome, email, ra] = l.split(",").map((s) => s.trim());
    return { nome, email, ra };
  });
  const r = await api(`/cursos/${cursoAtivo}/alunos`, { method: "POST", body: { alunos } });
  aviso("ok", `${r.inscritos} aluno(s) inscritos — nomes no Postgres, hashes no contrato.`);
  e.target.reset();
  await mostrarCurso();
});

acao($("#f-presenca"), "submit", async (e) => {
  if (!cursoAtivo) throw new Error("selecione um curso no passo 1");
  const d = form(e.target);
  const r = await api(`/cursos/${cursoAtivo}/presencas`, { method: "POST", body: { aula: +d.aula, ras: rasDe(d.ras) } });
  aviso("ok", `Presenças da aula ${r.aula} validadas pelo professor (oráculo).`);
  await listarAlunos();
});

acao($("#btn-encerrar"), "click", async () => {
  if (!cursoAtivo) throw new Error("selecione um curso no passo 1");
  const r = await api(`/cursos/${cursoAtivo}/encerrar`, { method: "POST" });
  aviso("ok", `Curso encerrado — o contrato auto-emitiu ${r.certificadosEmitidos} certificado(s).`);
  await carregarCursos(cursoAtivo);
});

acao($("#f-codigos"), "submit", async () => {
  if (!cursoAtivo) throw new Error("selecione um curso no passo 1");
  const r = await api(`/cursos/${cursoAtivo}/avaliacoes/habilitar`, { method: "POST", body: {} });
  const out = $("#out-codigos");
  out.hidden = false;
  out.textContent = `Códigos gerados (imprima, recorte e distribua embaralhados):\n\n${r.codigos.join("\n")}`;
  aviso("ok", `${r.quantidade} código(s) habilitados no contrato (só os hashes foram on-chain).`);
});

acao($("#f-avaliar"), "submit", async (e) => {
  if (!cursoAtivo) throw new Error("selecione um curso no passo 1");
  const d = form(e.target);
  const r = await api(`/cursos/${cursoAtivo}/avaliacoes`, { method: "POST", body: {
    nota: +d.nota, comentario: d.comentario, codigo: d.codigo,
  }});
  const m = $("#out-media");
  m.hidden = false;
  m.textContent = `Voto registrado. Média atual: ${r.media.toFixed(2)} (${r.votos} votos). ` +
    `Hash do seu código no evento: ${r.hashCodigo.slice(0, 18)}… — confira que sua nota entrou.`;
  aviso("ok", "Avaliação anônima registrada on-chain.");
  e.target.reset();
});

acao($("#f-verificar"), "submit", async (e) => {
  const { certId } = form(e.target);
  const c = await api(`/certificados/${certId}`);
  const out = $("#out-verificar");
  out.hidden = false;
  out.innerHTML = `
    <b>Situação</b><span>${c.valido ? "✅ válido" : "❌ revogado"}</span>
    <b>Curso</b><span>${c.nomeCurso} (${c.cargaHoraria} h)</span>
    <b>Frequência</b><span>${c.aulasPresentes} de ${c.totalAulas} aulas</span>
    <b>Emitido em</b><span>${new Date(c.dataEmissao).toLocaleDateString("pt-BR")}</span>
    <b>ID anônimo do aluno</b><span class="hash">${c.alunoId}</span>`;
  // Botão para baixar o PDF
  const pdfDiv  = $("#out-pdf");
  const pdfLink = $("#link-pdf");
  pdfDiv.hidden = false;
  pdfLink.href  = `/api/certificados/${certId}/pdf`;
});

// ----------------------------------------------------------------- startup
(async () => {
  try {
    const i = await api("/info");
    $("#foot-info").textContent = `contrato ${i.contrato} · chainId ${i.chainId} · deploy ${i.deployEm}`;
    await carregarCursos();
  } catch (e) {
    $("#foot-info").textContent = "API ainda subindo — recarregue em alguns segundos.";
  }

  // Roteamento por hash: #verificar/42 auto-preenche e verifica o certificado
  const hashMatch = window.location.hash.match(/^#verificar\/(\d+)$/);
  if (hashMatch) {
    const certId = hashMatch[1];
    const input = document.querySelector("#f-verificar [name=certId]");
    if (input) {
      input.value = certId;
      document.getElementById("verificar").scrollIntoView({ behavior: "smooth" });
      document.getElementById("f-verificar").requestSubmit();
    }
  }
})();
