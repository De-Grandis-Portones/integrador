// Conexión de solo lectura a la base de Planificación Planta - vive en el
// mismo proyecto Supabase que esta app, así que en vez de duplicar la
// info de rendiciones/gastos vía una API, se consulta directo la misma
// Postgres (mismo patrón probado en Integrador/dflex-sync-backend).
require('dotenv').config();
const { Pool } = require('pg');

const PLANTA_SUPABASE_DB_URL = process.env.PLANTA_SUPABASE_DB_URL;

if (!PLANTA_SUPABASE_DB_URL) {
  console.warn('[plantaDb] Falta PLANTA_SUPABASE_DB_URL — la sección de Rendiciones no va a funcionar.');
}

const pool = PLANTA_SUPABASE_DB_URL
  ? new Pool({ connectionString: PLANTA_SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
  : null;

if (pool) {
  pool.on('error', (err) => console.error('Error en pool de Planta/Supabase:', err));
}

function query(text, params) {
  if (!pool) throw new Error('PLANTA_SUPABASE_DB_URL no está configurado');
  return pool.query(text, params);
}

module.exports = { query };
