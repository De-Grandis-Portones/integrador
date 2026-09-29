// Sección "Rendiciones" - nexo con Planificación Planta: listado de
// rendiciones YA aprobadas por logística (izquierda) y, al entrar a una, el
// detalle de sus gastos. Mientras no esté conectado el correo de pagos con
// tarjeta, desde acá se mandan los gastos a Odoo a mano (factura + pago en
// borrador, ver services/rendicionOdooLoader.js). Las tablas de Planta se
// leen, nunca se escriben: lo único propio de esta app es
// arca_rendiciones_archivadas (ver abajo).
const express = require('express');
const plantaDb = require('../plantaDb');
const { crearBorradorDesdeGasto, buscarGastosCargados } = require('../services/rendicionOdooLoader');

const router = express.Router();

// Rendiciones pasadas al historial A MANO aunque les queden gastos sin enviar a
// Odoo (las completas pasan solas, eso se calcula contra Odoo). Tabla propia de
// esta app en el mismo Supabase; se crea sola la primera vez.
let tablaArchivadasLista = null;
function asegurarTablaArchivadas() {
  if (!tablaArchivadasLista) {
    tablaArchivadasLista = plantaDb
      .query(
        `create table if not exists public.arca_rendiciones_archivadas (
           viaje_id integer primary key,
           archivada_at timestamptz not null default now()
         );`
      )
      .catch((err) => {
        tablaArchivadasLista = null;
        throw err;
      });
  }
  return tablaArchivadasLista;
}

async function leerArchivada(viajeId) {
  await asegurarTablaArchivadas();
  const { rows } = await plantaDb.query(
    'select archivada_at from public.arca_rendiciones_archivadas where viaje_id = $1;',
    [viajeId]
  );
  return rows[0]?.archivada_at || null;
}

// Una fila por viaje con rendición aprobada, con el total ya sumado y cuántos
// de sus gastos ya están en Odoo. Va al historial si está "completa" (todos en
// Odoo) o si se archivó a mano.
router.get('/', async (req, res) => {
  try {
    await asegurarTablaArchivadas();
    const { rows } = await plantaDb.query(
      `select vi.id as viaje_id, vi.nombre as viaje_nombre, vi.fecha::text as viaje_fecha,
              vi.rendicion_aprobada_por, vi.rendicion_aprobada_at, vi.fondo_efectivo,
              c.nombre as cuadrilla_nombre,
              count(g.id)::int as cantidad_gastos,
              array_agg(g.id) as gasto_ids,
              coalesce(sum(g.monto), 0) as total,
              coalesce(sum(g.monto) filter (where g.medio_pago = 'efectivo'), 0) as total_efectivo,
              ar.archivada_at
         from public.logistica_viajes vi
         join public.logistica_gastos g on g.viaje_id = vi.id
         left join public.logistica_cuadrillas c on c.id = vi.cuadrilla_id
         left join public.arca_rendiciones_archivadas ar on ar.viaje_id = vi.id
        where vi.rendicion_aprobada_at is not null
        group by vi.id, vi.nombre, vi.fecha, vi.rendicion_aprobada_por, vi.rendicion_aprobada_at, vi.fondo_efectivo, c.nombre, ar.archivada_at
        order by vi.rendicion_aprobada_at desc;`
    );

    // Si Odoo no responde, todas quedan como pendientes (nunca se esconde una
    // rendición por no poder confirmar que ya se cargó).
    let cargados = new Map();
    let errorOdoo = null;
    try {
      cargados = await buscarGastosCargados(rows.flatMap((r) => r.gasto_ids));
    } catch (err) {
      errorOdoo = `No se pudo consultar Odoo: ${err.message}`;
    }

    const rendiciones = rows.map(({ gasto_ids, ...r }) => {
      const cantidadEnOdoo = gasto_ids.filter((id) => cargados.has(id)).length;
      const completa = !errorOdoo && cantidadEnOdoo === gasto_ids.length;
      return {
        ...r,
        saldo_a_devolver: r.fondo_efectivo != null ? Number(r.fondo_efectivo) - Number(r.total_efectivo) : null,
        cantidad_en_odoo: cantidadEnOdoo,
        completa,
        archivada_manual: !!r.archivada_at,
        en_historial: completa || !!r.archivada_at,
      };
    });
    res.json({ rendiciones, error_odoo: errorOdoo });
  } catch (err) {
    console.error('Error en GET /rendiciones:', err);
    res.status(500).json({ error: err.message });
  }
});

async function leerViajeAprobado(viajeId) {
  const { rows } = await plantaDb.query(
    `select vi.id as viaje_id, vi.nombre as viaje_nombre, vi.fecha::text as viaje_fecha,
            vi.hora_salida_real, vi.hora_llegada_real, vi.rendicion_aprobada_por, vi.rendicion_aprobada_at,
            vi.fondo_efectivo, c.nombre as cuadrilla_nombre
       from public.logistica_viajes vi
       left join public.logistica_cuadrillas c on c.id = vi.cuadrilla_id
      where vi.id = $1 and vi.rendicion_aprobada_at is not null;`,
    [viajeId]
  );
  return rows[0] || null;
}

async function leerGastos(viajeId) {
  const { rows } = await plantaDb.query(
    `select id, fecha::text as fecha, motivo, monto, storage_path, nombre_archivo, tipo_mime, cargado_por,
            tipo_comprobante, medio_pago, estado_revision, detalle_revision, campos_inciertos, created_at
       from public.logistica_gastos
      where viaje_id = $1
      order by fecha asc, created_at asc;`,
    [viajeId]
  );
  return rows;
}

// Detalle de una rendición: datos del viaje + cada gasto cargado, con su estado en Odoo.
router.get('/:viajeId', async (req, res) => {
  try {
    const viajeId = Number(req.params.viajeId);
    const viaje = await leerViajeAprobado(viajeId);
    if (!viaje) return res.status(404).json({ error: 'Rendición no encontrada (o todavía no aprobada por logística)' });

    const gastosDb = await leerGastos(viajeId);

    // Si Odoo no responde, el detalle se muestra igual pero sin poder enviar
    // (no se sabe qué ya está cargado y no queremos duplicar).
    let cargados = new Map();
    let errorOdoo = null;
    try {
      cargados = await buscarGastosCargados(gastosDb.map((g) => g.id));
    } catch (err) {
      errorOdoo = `No se pudo consultar Odoo: ${err.message}`;
    }

    const gastos = gastosDb.map(({ storage_path, ...g }) => ({ ...g, odoo: cargados.get(g.id) || null }));

    const total = gastos.reduce((acc, g) => acc + Number(g.monto), 0);
    const totalEfectivo = gastos.filter((g) => g.medio_pago === 'efectivo').reduce((acc, g) => acc + Number(g.monto), 0);
    const fondoEfectivo = viaje.fondo_efectivo != null ? Number(viaje.fondo_efectivo) : null;
    const saldoADevolver = fondoEfectivo != null ? fondoEfectivo - totalEfectivo : null;

    const archivadaAt = await leerArchivada(viajeId);

    res.json({
      ...viaje, gastos, total, total_efectivo: totalEfectivo, saldo_a_devolver: saldoADevolver, error_odoo: errorOdoo,
      archivada_manual: !!archivadaAt, archivada_at: archivadaAt,
    });
  } catch (err) {
    console.error('Error en GET /rendiciones/:viajeId:', err);
    res.status(500).json({ error: err.message });
  }
});

// Envía a Odoo los gastos seleccionados: body { gastos: [{ gastoId, partnerId, accountId, journalKey }] }.
// Fecha, monto y comprobante se toman SIEMPRE de la base de Planta, no del navegador.
router.post('/:viajeId/cargar', async (req, res) => {
  try {
    const viajeId = Number(req.params.viajeId);
    const pedidos = Array.isArray(req.body?.gastos) ? req.body.gastos : [];
    if (!pedidos.length) return res.status(400).json({ error: 'No se recibieron gastos para enviar' });

    const viaje = await leerViajeAprobado(viajeId);
    if (!viaje) return res.status(404).json({ error: 'Rendición no encontrada (o todavía no aprobada por logística)' });
    if (await leerArchivada(viajeId)) {
      return res.status(409).json({ error: 'Esta rendición está en el historial: volvela a pendientes para enviar gastos.' });
    }

    const gastosPorId = new Map((await leerGastos(viajeId)).map((g) => [g.id, g]));
    const cargados = await buscarGastosCargados(pedidos.map((p) => p.gastoId));

    const resultados = [];
    // Secuencial a propósito, igual que el importador: son escrituras reales en Odoo.
    for (const pedido of pedidos) {
      const gasto = gastosPorId.get(Number(pedido.gastoId));
      if (!gasto) {
        resultados.push({ ok: false, gastoId: pedido.gastoId, error: 'El gasto no pertenece a esta rendición.' });
        continue;
      }
      if (cargados.has(gasto.id)) {
        resultados.push({ ok: false, gastoId: gasto.id, code: 'ya_cargado', error: `Ya estaba cargado en Odoo (${cargados.get(gasto.id).name}).` });
        continue;
      }
      try {
        const r = await crearBorradorDesdeGasto(gasto, viaje, {
          partnerId: Number(pedido.partnerId),
          accountId: Number(pedido.accountId),
          journalKey: pedido.journalKey,
        });
        resultados.push({ ok: true, gastoId: gasto.id, ...r });
      } catch (err) {
        resultados.push({ ok: false, gastoId: gasto.id, error: err.message });
      }
    }

    res.json({ resultados });
  } catch (err) {
    console.error('Error en POST /rendiciones/:viajeId/cargar:', err);
    res.status(500).json({ error: err.message });
  }
});

// Pasar al historial a mano (aunque queden gastos sin enviar) / volver a pendientes.
router.post('/:viajeId/archivar', async (req, res) => {
  try {
    const viajeId = Number(req.params.viajeId);
    if (!(await leerViajeAprobado(viajeId))) {
      return res.status(404).json({ error: 'Rendición no encontrada (o todavía no aprobada por logística)' });
    }
    await plantaDb.query(
      'insert into public.arca_rendiciones_archivadas (viaje_id) values ($1) on conflict (viaje_id) do nothing;',
      [viajeId]
    );
    res.json({ ok: true, archivada_at: await leerArchivada(viajeId) });
  } catch (err) {
    console.error('Error en POST /rendiciones/:viajeId/archivar:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:viajeId/archivar', async (req, res) => {
  try {
    await asegurarTablaArchivadas();
    await plantaDb.query('delete from public.arca_rendiciones_archivadas where viaje_id = $1;', [Number(req.params.viajeId)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error en DELETE /rendiciones/:viajeId/archivar:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
