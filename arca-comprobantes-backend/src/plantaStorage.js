// Descarga de los comprobantes que la cuadrilla sube en Planificación Planta
// (foto/PDF de cada gasto de la rendición). Viven en el bucket PRIVADO
// "logistica-adjuntos" del mismo proyecto Supabase (ver en Planta
// Backend/server/lib/logisticaAdjuntosStorage.js). Se usa la API REST de
// Storage directo con axios para no sumar @supabase/supabase-js solo por esto.
require('dotenv').config();
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'logistica-adjuntos';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[plantaStorage] Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — los comprobantes de rendiciones no se van a adjuntar en Odoo.');
}

function storageConfigurado() {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

async function descargarComprobante(storagePath) {
  if (!storageConfigurado()) throw new Error('Supabase Storage no está configurado (falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  const ruta = String(storagePath).split('/').map(encodeURIComponent).join('/');
  const res = await axios.get(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${ruta}`, {
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, apikey: SUPABASE_SERVICE_ROLE_KEY },
    responseType: 'arraybuffer',
    timeout: 30000,
  });
  return Buffer.from(res.data);
}

module.exports = { descargarComprobante, storageConfigurado };
