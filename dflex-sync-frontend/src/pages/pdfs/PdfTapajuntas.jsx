// src/pages/pdfs/PdfTapajuntas.jsx
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

// =====================
// AJUSTES FINOS
// =====================
// Altura (Y): negativo = baja el texto; positivo = sube el texto
const ROW_Y_OFFSET = -9;

// Fecha: positivo = mueve a la derecha; negativo = a la izquierda
const FECHA_X_OFFSET = 20;

// =====================
// Helpers
// =====================
function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function toNum(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).replace(',', '.');
  const m = s.match(/-?\d+(\.\d+)?/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function todayDDMMYY() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${yy}`;
}


function normalizeYYYYMMDD(v) {
  const s = toStr(v);
  if (!s) return '';

  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  return '';
}


function getInicioProdImput(row) {
  // Robusto a distintas capitalizaciones/alias, pero prioriza el nombre real: inicio_prod_imput
  return normalizeYYYYMMDD(
    row?.inicio_prod_imput ??
      row?.Inicio_prod_imput ??
      row?.INICIO_PROD_IMPUT ??
      row?.inicioProdImput ??
      row?.Inicio_Prod_Imput ??
      row?.inicio_prod ??
      row?.INICIO_PROD
  );
}

function yyyymmddToDDMMYY(yyyymmdd) {
  const s = normalizeYYYYMMDD(yyyymmdd);
  if (!s) return '';
  const [Y, M, D] = s.split('-');
  return `${D}-${M}-${Y.slice(-2)}`;
}

// Heurística: si viene en cm (<500), pasamos a mm (*10). Si ya es mm, queda igual.
function toMM(n) {
  const v = toNum(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v < 500 ? v * 10 : v;
}

function getParanteDesc(row) {
  return (
    toStr(row.PARANTE_Descripcion) ||
    toStr(row.PARANTES_Descripcion) ||
    toStr(row.Parante_Descripcion) ||
    toStr(row.Parantes_Descripcion)
  );
}

function getPiernasAlturaRaw(row) {
  return (
    row.PIERNAS_Altura ??
    row.Piernas_Altura ??
    row.PIERNA_Altura ??
    row.Pierna_Altura ??
    row.PIERNAS_ALTURA ??
    row.piernas_altura
  );
}

function calcDescripcionArticulo(row) {
  const raw = getParanteDesc(row);
  const norm = raw.replace(/\s+/g, '').toUpperCase(); // "40x50" -> "40X50"
  if (norm === '40X50' || norm === '50X50' || norm === '30X50') return 'PLEGADO1';
  return 'PLEGADO2';
}

function calcLargoTotalMM(row) {
  // Largo total = (PIERNAS_Altura/2) + 75  (en mm)
  const altura = toMM(getPiernasAlturaRaw(row));
  if (!altura) return '';
  const val = altura / 2 + 75;
  return Number.isFinite(val) ? String(Math.round(val)) : '';
}

// Dibuja texto con “fit” simple
function drawFittedText(page, font, text, x, y, opts = {}) {
  const { size = 9, maxWidth = null, minSize = 7, color = rgb(0, 0, 0) } = opts;

  const t = toStr(text);
  if (!t) return;

  if (!maxWidth) {
    page.drawText(t, { x, y, size, font, color });
    return;
  }

  let s = size;
  while (s >= minSize) {
    const w = font.widthOfTextAtSize(t, s);
    if (w <= maxWidth) break;
    s -= 0.5;
  }

  let finalText = t;
  if (font.widthOfTextAtSize(finalText, s) > maxWidth) {
    while (finalText.length > 0 && font.widthOfTextAtSize(finalText + '…', s) > maxWidth) {
      finalText = finalText.slice(0, -1);
    }
    finalText = finalText ? finalText + '…' : '';
  }

  page.drawText(finalText, { x, y, size: s, font, color });
}

// =====================
// Coordenadas (Tapajuntas)
// =====================
const POS = {
  header: {
    partidaX: 122.4,
    partidaY: 732.5,
    fechaX: 498.5 + FECHA_X_OFFSET,
    fechaY: 729.5,
    size: 12,
  },

  table: {
    yRows: [
      674.375, 659.875, 645.375, 630.875, 616.375,
      601.875, 587.25, 572.75, 558.25, 543.75,
      529.25, 514.75, 500.25, 485.75, 471.25,
    ].map((y) => y + ROW_Y_OFFSET),
    x: {
      nv: 46,
      desc: 120,
      largo: 186,
      obs: 245,
    },
    maxWidth: {
      nv: 55,
      desc: 60,
      largo: 45,
      obs: 320,
    },
  },
};

// =====================
// Fetch: privado si hay token, público si NO hay token
// =====================
function getValoresEndpoint(accessToken) {
  return accessToken ? '/api/pre-produccion-valores' : '/api/public/pre-produccion-valores';
}

async function fetchValoresByPartida(partida, accessToken) {
  const p = toStr(partida);
  if (!p) return [];

  const url = `${API_BASE_URL}${getValoresEndpoint(accessToken)}?partida=${encodeURIComponent(p)}`;
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;

  const res = await fetch(url, headers ? { headers } : undefined);

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} en ${url}${txt ? `: ${txt}` : ''}`);
  }

  const data = await res.json();
  return Array.isArray(data?.rows) ? data.rows : [];
}

async function fetchValoresByFechaProduccion(fechaProduccion, accessToken) {
  const f = normalizeYYYYMMDD(fechaProduccion);
  if (!f) return [];

  const base = `${API_BASE_URL}${getValoresEndpoint(accessToken)}`;
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;

  // Preferimos el nuevo criterio: inicio_prod_imput (YYYY-MM-DD). Si el backend aún no lo soporta,
  // intentamos compatibilidad hacia atrás con inicio_prod_imput.
  const urlNew = `${base}?inicio_prod_imput=${encodeURIComponent(f)}`;
  let res = await fetch(urlNew, headers ? { headers } : undefined);
  if (!res.ok && (res.status === 400 || res.status === 404)) {
    const urlOld = `${base}?fecha_envio_produccion=${encodeURIComponent(f)}`;
    res = await fetch(urlOld, headers ? { headers } : undefined);
  }
if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} en ${base}${txt ? `: ${txt}` : ''}`);
  }

  const data = await res.json();
  const rows = Array.isArray(data?.rows) ? data.rows : [];

  // Aseguramos el agrupamiento por inicio_prod_imput del lado del front,
  // por si el backend no está filtrando correctamente.
  const filtered = rows.filter((r) => getInicioProdImput(r) === f);

  // Si el backend devuelve filas pero no trae el campo inicio_prod_imput, no podemos filtrar acá.
  const anyHasInicio = rows.some((r) => !!getInicioProdImput(r));
  if (!anyHasInicio) return rows;

  return filtered;
}

// =====================
// Export público
// =====================
export async function generatePdfTapajuntas(partida, rows, accessToken) {
  const p = toStr(partida);
  if (!p) throw new Error('Partida vacía');

  const safeRows = Array.isArray(rows) ? rows : await fetchValoresByPartida(p, accessToken);
  if (!safeRows.length) throw new Error(`No hay filas en pre-produccion-valores para PARTIDA=${p}`);

  const base = import.meta.env.BASE_URL || '/';
  const templateUrl = `${base}pdf_modelo_tapajuntas.pdf`;

  const templateRes = await fetch(templateUrl);
  if (!templateRes.ok) {
    throw new Error(
      `No se pudo cargar la plantilla ${templateUrl} (status ${templateRes.status}). Revisá /public/pdf_modelo_tapajuntas.pdf`
    );
  }

  const templateBytes = await templateRes.arrayBuffer();
  const head = new Uint8Array(templateBytes.slice(0, 4));
  const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
  if (!isPdf) {
    throw new Error(`La plantilla ${templateUrl} no parece un PDF válido (no empieza con %PDF).`);
  }

  const templateDoc = await PDFDocument.load(templateBytes);
  const outDoc = await PDFDocument.create();
  const font = await outDoc.embedFont(StandardFonts.Helvetica);

  const items = [...safeRows].sort((a, b) => toNum(a.NV) - toNum(b.NV));
  const pageSize = POS.table.yRows.length;

  for (let i = 0; i < items.length; i += pageSize) {
    const chunk = items.slice(i, i + pageSize);

    const [page] = await outDoc.copyPages(templateDoc, [0]);
    outDoc.addPage(page);

    // Header
    drawFittedText(page, font, p, POS.header.partidaX, POS.header.partidaY, {
      size: POS.header.size,
      maxWidth: 120,
    });

    drawFittedText(page, font, todayDDMMYY(), POS.header.fechaX, POS.header.fechaY, {
      size: POS.header.size,
      maxWidth: 90,
    });

    // Tabla
    chunk.forEach((r, idx) => {
      const y = POS.table.yRows[idx];
      if (y === undefined) return;

      const nv = toStr(r.NV);
      const descArticulo = calcDescripcionArticulo(r);
      const largoTotal = calcLargoTotalMM(r);
      const obs = '';

      drawFittedText(page, font, nv, POS.table.x.nv, y, {
        maxWidth: POS.table.maxWidth.nv,
        size: 9,
        minSize: 7,
      });

      drawFittedText(page, font, descArticulo, POS.table.x.desc, y, {
        maxWidth: POS.table.maxWidth.desc,
        size: 9,
        minSize: 7,
      });

      drawFittedText(page, font, largoTotal, POS.table.x.largo, y, {
        maxWidth: POS.table.maxWidth.largo,
        size: 9,
        minSize: 7,
      });

      drawFittedText(page, font, obs, POS.table.x.obs, y, {
        maxWidth: POS.table.maxWidth.obs,
        size: 9,
        minSize: 7,
      });
    });
  }

  const bytes = await outDoc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

// wrapper para ViewPdf / PdfLinkView

export async function generatePdfTapajuntasByFechaProduccion(fechaProduccion, accessToken) {
  const f = normalizeYYYYMMDD(fechaProduccion);
  if (!f) throw new Error('Falta parámetro "fecha" (YYYY-MM-DD)');

  const rows = await fetchValoresByFechaProduccion(f, accessToken);
  if (!rows.length) throw new Error(`No hay filas en pre-produccion-valores para inicio_prod_imput=${f}`);

  const headerKey = yyyymmddToDDMMYY(f) || f;
  return generatePdfTapajuntas(headerKey, rows, accessToken);
}

// ✅ NUEVO: rango (una misma lista, sin separar por fecha)
function buildDateRangeInclusive(fromYYYYMMDD, toYYYYMMDD) {
  const from = normalizeYYYYMMDD(fromYYYYMMDD);
  const to = normalizeYYYYMMDD(toYYYYMMDD);
  if (!from || !to) return [];

  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  if (start.getTime() > end.getTime()) return [];

  const out = [];
  const cur = new Date(start);
  let guard = 0;
  while (cur.getTime() <= end.getTime()) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard += 1;
    if (guard > 370) break;
  }
  return out;
}

function uniqByNV(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const k = toStr(r?.NV ?? r?.nv);
    if (!k) continue;
    if (!m.has(k)) m.set(k, r);
  }
  return Array.from(m.values());
}

export async function generatePdfTapajuntasByRangoProduccion(desde, hasta, accessToken) {
  const d = normalizeYYYYMMDD(desde);
  const h = normalizeYYYYMMDD(hasta);
  if (!d || !h) throw new Error('Faltan fechas (YYYY-MM-DD) para el rango.');

  const days = buildDateRangeInclusive(d, h);
  if (!days.length) throw new Error('Rango inválido (desde > hasta o formato incorrecto).');

  let all = [];
  for (const day of days) {
    const rows = await fetchValoresByFechaProduccion(day, accessToken);
    if (rows?.length) all = all.concat(rows);
  }

  all = uniqByNV(all);
  if (!all.length) throw new Error(`No hay filas para inicio_prod_imput entre ${d} y ${h}`);

  // Tapajuntas imprime "partida" en header: usamos texto de rango
  const headerKey = `${yyyymmddToDDMMYY(d)} a ${yyyymmddToDDMMYY(h)}`;
  return generatePdfTapajuntas(headerKey, all, accessToken);
}

export default {
  generatePdfTapajuntas,
  generatePdfTapajuntasByFechaProduccion,
  generatePdfTapajuntasByRangoProduccion,
};
