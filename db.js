require('dotenv').config(); // <-- Debe ir en la línea 1
const { Pool } = require('pg');

// Imprime en consola para verificar que la variable se lea correctamente
if (!process.env.DATABASE_URL) {
  console.error('ERROR CRÍTICO: No se encontró DATABASE_URL en el archivo .env');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};