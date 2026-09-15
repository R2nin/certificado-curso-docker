-- Executado automaticamente pela imagem oficial do Postgres na PRIMEIRA
-- subida do volume (docker-entrypoint-initdb.d). Guarda apenas o que fica
-- OFF-CHAIN por decisão de projeto (LGPD): dados pessoais e códigos gerados.

CREATE TABLE IF NOT EXISTS alunos (
    curso_id   BIGINT      NOT NULL,
    ra         TEXT        NOT NULL,
    nome       TEXT        NOT NULL,
    email      TEXT,
    aluno_id   TEXT        NOT NULL,          -- keccak256(sal + ":" + RA), espelho do ID on-chain
    criado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (curso_id, ra)
);

CREATE TABLE IF NOT EXISTS codigos_avaliacao (
    id         BIGSERIAL   PRIMARY KEY,
    curso_id   BIGINT      NOT NULL,
    codigo     TEXT        NOT NULL UNIQUE,   -- em claro: só o professor vê, para imprimir
    hash       TEXT        NOT NULL,          -- keccak256(codigo) — o que vai on-chain
    criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alunos_curso ON alunos (curso_id);
CREATE INDEX IF NOT EXISTS idx_codigos_curso ON codigos_avaliacao (curso_id);
