// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CertificadoCurso (v2 — sem carteiras de alunos)
 * @author Arthur Naoto Miura (FEMA/IMESA)
 * @notice Gestão de cursos de curricularização com:
 *   (1) INSCRIÇÃO por identificador anônimo (bytes32 = keccak256(sal + RA)),
 *       importada do Google Forms via script off-chain — nenhum dado pessoal on-chain (LGPD);
 *   (2) PRESENÇA validada pelo professor (oráculo humano). Ao encerrar o curso,
 *       o contrato AUTO-EXECUTA a emissão dos certificados de todos os alunos
 *       que atingiram a frequência mínima — sem decisão caso a caso;
 *   (3) AVALIAÇÃO on-chain anônima: códigos secretos distribuídos aos certificados;
 *       o contrato registra a nota de quem apresentar um código válido, uma única vez.
 *
 * Derivado do TCC "Blockchain e Smart Contracts: barreiras à sua adoção".
 */
contract CertificadoCurso is Ownable {

    struct Curso {
        string nome;
        uint16 cargaHoraria;      // horas
        uint8 totalAulas;         // nº de encontros
        uint8 presencaMinimaPct;  // ex.: 75 (%)
        bool ativo;               // aceita inscrições/presenças
        bool encerrado;           // certificados já emitidos
        uint32 somaNotas;         // módulo de avaliação
        uint32 qtdAvaliacoes;
    }

    struct Certificado {
        uint256 cursoId;
        bytes32 alunoId;
        uint8 aulasPresentes;
        uint64 dataEmissao;
        bool revogado;
    }

    uint256 private _nextCursoId = 1;
    uint256 private _nextCertId = 1;

    mapping(uint256 => Curso) public cursos;
    mapping(uint256 => bytes32[]) private _inscritosLista;                     // p/ iteração no encerramento
    mapping(uint256 => mapping(bytes32 => bool)) public inscritos;             // cursoId => alunoId
    mapping(uint256 => mapping(bytes32 => uint8)) public presencas;            // contador de aulas
    mapping(uint256 => mapping(uint8 => mapping(bytes32 => bool))) public presenteNaAula; // anti-duplicidade
    mapping(uint256 => Certificado) public certificados;                       // certId => Certificado
    mapping(uint256 => mapping(bytes32 => uint256)) public certificadoDe;      // cursoId => alunoId => certId
    mapping(uint256 => mapping(bytes32 => uint8)) public codigosAvaliacao;     // cursoId => hash(código) => 0=inexistente,1=disponível,2=usado

    event CursoCriado(uint256 indexed cursoId, string nome, uint16 cargaHoraria, uint8 totalAulas, uint8 presencaMinimaPct);
    event AlunoInscrito(uint256 indexed cursoId, bytes32 indexed alunoId);
    event PresencaRegistrada(uint256 indexed cursoId, uint8 indexed aula, uint256 qtdPresentes);
    event CertificadoEmitido(uint256 indexed certId, uint256 indexed cursoId, bytes32 indexed alunoId, uint8 aulasPresentes);
    event CursoEncerrado(uint256 indexed cursoId, uint256 certificadosEmitidos);
    event CertificadoRevogado(uint256 indexed certId, string motivo);
    event AvaliacaoHabilitada(uint256 indexed cursoId, uint256 qtdCodigos);
    event AvaliacaoRegistrada(uint256 indexed cursoId, bytes32 indexed hashCodigo, uint8 nota, string comentario);

    error CursoInexistente();
    error CursoInativo();
    error CursoJaEncerrado();
    error CursoNaoEncerrado();
    error AulaInvalida();
    error CertificadoInexistente();
    error CodigoInvalido();
    error CodigoJaUtilizado();
    error NotaInvalida();

    constructor() Ownable(msg.sender) {}

    modifier cursoValido(uint256 cursoId) {
        if (bytes(cursos[cursoId].nome).length == 0) revert CursoInexistente();
        _;
    }

    // ============ MÓDULO 1 — CURSO E INSCRIÇÕES (Google Forms -> script) ============

    function criarCurso(
        string calldata nome,
        uint16 cargaHoraria,
        uint8 totalAulas,
        uint8 presencaMinimaPct
    ) external onlyOwner returns (uint256 cursoId) {
        require(totalAulas > 0 && presencaMinimaPct <= 100, "parametros invalidos");
        cursoId = _nextCursoId++;
        cursos[cursoId] = Curso(nome, cargaHoraria, totalAulas, presencaMinimaPct, true, false, 0, 0);
        emit CursoCriado(cursoId, nome, cargaHoraria, totalAulas, presencaMinimaPct);
    }

    /// @notice Inscreve alunos pelos IDs anônimos (keccak256 do sal + RA), em lote.
    function inscreverLote(uint256 cursoId, bytes32[] calldata alunoIds)
        external onlyOwner cursoValido(cursoId)
    {
        Curso storage c = cursos[cursoId];
        if (c.encerrado) revert CursoJaEncerrado();
        if (!c.ativo) revert CursoInativo();
        for (uint256 i = 0; i < alunoIds.length; i++) {
            if (!inscritos[cursoId][alunoIds[i]]) {
                inscritos[cursoId][alunoIds[i]] = true;
                _inscritosLista[cursoId].push(alunoIds[i]);
                emit AlunoInscrito(cursoId, alunoIds[i]);
            }
        }
    }

    function totalInscritos(uint256 cursoId) external view returns (uint256) {
        return _inscritosLista[cursoId].length;
    }

    // ============ MÓDULO 2 — PRESENÇA (professor como oráculo) + AUTO-EMISSÃO ============

    /// @notice Professor valida a presença de uma aula. Ignora não inscritos e duplicatas.
    function registrarPresenca(uint256 cursoId, uint8 aula, bytes32[] calldata presentes)
        external onlyOwner cursoValido(cursoId)
    {
        Curso storage c = cursos[cursoId];
        if (c.encerrado) revert CursoJaEncerrado();
        if (!c.ativo) revert CursoInativo();
        if (aula == 0 || aula > c.totalAulas) revert AulaInvalida();

        uint256 registrados;
        for (uint256 i = 0; i < presentes.length; i++) {
            bytes32 a = presentes[i];
            if (inscritos[cursoId][a] && !presenteNaAula[cursoId][aula][a]) {
                presenteNaAula[cursoId][aula][a] = true;
                presencas[cursoId][a] += 1;
                registrados++;
            }
        }
        emit PresencaRegistrada(cursoId, aula, registrados);
    }

    /**
     * @notice Encerra o curso e AUTO-EXECUTA a emissão: o contrato percorre os
     *         inscritos e emite certificado para todos com frequência >= mínima.
     *         O professor não escolhe quem recebe — o critério codificado decide.
     */
    function encerrarCurso(uint256 cursoId)
        external onlyOwner cursoValido(cursoId) returns (uint256 emitidos)
    {
        Curso storage c = cursos[cursoId];
        if (c.encerrado) revert CursoJaEncerrado();
        c.ativo = false;
        c.encerrado = true;

        bytes32[] storage lista = _inscritosLista[cursoId];
        for (uint256 i = 0; i < lista.length; i++) {
            bytes32 a = lista[i];
            uint8 freq = presencas[cursoId][a];
            // freq/totalAulas >= pct/100  <=>  freq*100 >= totalAulas*pct
            if (uint256(freq) * 100 >= uint256(c.totalAulas) * c.presencaMinimaPct) {
                uint256 certId = _nextCertId++;
                certificados[certId] = Certificado(cursoId, a, freq, uint64(block.timestamp), false);
                certificadoDe[cursoId][a] = certId;
                emitidos++;
                emit CertificadoEmitido(certId, cursoId, a, freq);
            }
        }
        emit CursoEncerrado(cursoId, emitidos);
    }

    function revogarCertificado(uint256 certId, string calldata motivo) external onlyOwner {
        if (certificados[certId].alunoId == bytes32(0)) revert CertificadoInexistente();
        certificados[certId].revogado = true;
        emit CertificadoRevogado(certId, motivo);
    }

    // ---------- Verificação pública (sem custo) ----------

    /// @notice Terceiros verificam um certificado pelo número impresso no documento.
    function verificarCertificado(uint256 certId)
        external view
        returns (bool valido, bytes32 alunoId, string memory nomeCurso, uint16 cargaHoraria, uint8 aulasPresentes, uint8 totalAulas, uint64 dataEmissao)
    {
        Certificado memory cert = certificados[certId];
        if (cert.alunoId == bytes32(0)) revert CertificadoInexistente();
        Curso memory c = cursos[cert.cursoId];
        return (!cert.revogado, cert.alunoId, c.nome, c.cargaHoraria, cert.aulasPresentes, c.totalAulas, cert.dataEmissao);
    }

    /// @notice Verificação a partir do ID anônimo do aluno (quem conhece RA + sal).
    function verificarPorAluno(uint256 cursoId, bytes32 alunoId) external view returns (uint256 certId, bool valido) {
        certId = certificadoDe[cursoId][alunoId];
        if (certId == 0) revert CertificadoInexistente();
        valido = !certificados[certId].revogado;
    }

    // ============ MÓDULO 3 — AVALIAÇÃO DO CURSO (on-chain, anônima, por código) ============

    /**
     * @notice Habilita a avaliação registrando os hashes (keccak256) dos códigos
     *         secretos. Gere um código por certificado emitido e distribua-os
     *         embaralhados — assim nenhuma avaliação é vinculável a um aluno.
     */
    function habilitarAvaliacao(uint256 cursoId, bytes32[] calldata hashesCodigos)
        external onlyOwner cursoValido(cursoId)
    {
        if (!cursos[cursoId].encerrado) revert CursoNaoEncerrado();
        for (uint256 i = 0; i < hashesCodigos.length; i++) {
            codigosAvaliacao[cursoId][hashesCodigos[i]] = 1; // disponível
        }
        emit AvaliacaoHabilitada(cursoId, hashesCodigos.length);
    }

    /**
     * @notice Registra a avaliação. Qualquer carteira pode enviar a transação
     *         (relayer), mas só um código secreto válido e inédito é aceito.
     *         O evento publica o hash do código: o aluno confere no Etherscan
     *         que SUA nota foi registrada sem adulteração.
     * @param nota 1 a 5
     * @param comentario texto curto opcional (evite dados pessoais)
     * @param codigo o código secreto recebido (em claro; é consumido no ato)
     */
    function avaliar(uint256 cursoId, uint8 nota, string calldata comentario, string calldata codigo)
        external cursoValido(cursoId)
    {
        if (nota < 1 || nota > 5) revert NotaInvalida();
        bytes32 h = keccak256(bytes(codigo));
        uint8 status = codigosAvaliacao[cursoId][h];
        if (status == 0) revert CodigoInvalido();
        if (status == 2) revert CodigoJaUtilizado();

        codigosAvaliacao[cursoId][h] = 2; // usado
        Curso storage c = cursos[cursoId];
        c.somaNotas += nota;
        c.qtdAvaliacoes += 1;
        emit AvaliacaoRegistrada(cursoId, h, nota, comentario);
    }

    /// @notice Média das avaliações multiplicada por 100 (ex.: 450 = 4,50).
    function mediaAvaliacao(uint256 cursoId) external view cursoValido(cursoId)
        returns (uint32 mediaX100, uint32 qtd)
    {
        Curso memory c = cursos[cursoId];
        qtd = c.qtdAvaliacoes;
        mediaX100 = qtd == 0 ? 0 : uint32((uint256(c.somaNotas) * 100) / qtd);
    }
}
