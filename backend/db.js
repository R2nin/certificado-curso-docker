// Pool de conexões com o PostgreSQL. A URL vem de variável de ambiente
// montada no docker-compose.yml — o host é o NOME do serviço ("db"),
// resolvido pela rede virtual que o Compose cria.
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function esperarBanco(tentativas = 30) {
  for (let i = 0; i < tentativas; i++) {
    try {
      await pool.query("SELECT 1");
      console.log("[backend] PostgreSQL conectado");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("PostgreSQL não respondeu a tempo");
}

module.exports = { pool, esperarBanco };
