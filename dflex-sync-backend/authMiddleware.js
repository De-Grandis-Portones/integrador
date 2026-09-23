// authMiddleware.js — requireAuth/attachRole/requireRole, extraídos de server.js
// (donde antes eran funciones locales, no exportadas) para que
// registerIpanelRoutes.js también pueda aplicarlos.
//
// Por qué hacía falta: registerIpanelRoutes.js se carga con `node -r
// ./registerIpanelRoutes.js server.js`, ANTES de que server.js corra, y
// registra sus rutas via un monkey-patch de Module._load/app.listen (ver ese
// archivo) - nunca tuvo forma de llegar a las funciones de auth de server.js
// porque nunca estuvieron exportadas. Resultado: las 11 rutas de ipanel
// (incluyendo escrituras y un trigger de sync) quedaron sin ningún auth,
// exponiendo datos de clientes (nombre/dirección/CUIT/teléfono) sin login.
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || null;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

// El pool para la consulta de rol se INYECTA vía configureRolePool en vez de
// crearse acá mismo: esta base de Supabase ya la comparten las 6 apps del
// ecosistema, y sumar un pool más (cada pg.Pool abre hasta 10 conexiones por
// default) al de server.js (supabasePool) y al de registerIpanelRoutes.js
// (ipanelPgPool) en el mismo proceso acercaba el total al límite de
// conexiones de Supabase sin necesidad real. server.js llama a
// configureRolePool(supabasePool) apenas lo crea (ver más abajo en ese
// archivo) - eso pasa mucho antes de que cualquier ruta real reciba un
// request, porque las rutas de ipanel recién se registran dentro del
// app.listen() parcheado, al final de todo. Si nunca se configura (o
// SUPABASE_DB_URL no está seteado), attachRole simplemente no resuelve rol
// (mismo fallback "viewer" que ya tenía antes).
let rolePool = null;
function configureRolePool(pool) {
  if (pool) rolePool = pool;
}
function getRolePool() {
  return rolePool;
}

async function requireAuth(req, res, next) {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Supabase admin no configurado' });
    }

    const hdr = req.headers.authorization || '';
    const m = hdr.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Falta token Bearer' });

    const token = m[1];
    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({ error: 'Token inválido' });
    }

    req.user = data.user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'No autorizado', details: e.message || String(e) });
  }
}

async function attachRole(req, _res, next) {
  try {
    req.role = 'viewer';
    const pool = getRolePool();
    if (!pool || !req.user?.id) return next();

    const r = await pool.query('SELECT role FROM app_users WHERE user_id = $1 LIMIT 1', [req.user.id]);
    req.role = r?.rows?.[0]?.role || 'viewer';
    next();
  } catch {
    req.role = 'viewer';
    next();
  }
}

function requireRole(allowedRoles) {
  const allowed = new Set(allowedRoles || []);
  return (req, res, next) => {
    const role = req.role || 'viewer';
    if (!allowed.has(role)) {
      return res.status(403).json({ error: 'No tenés permisos', role });
    }
    next();
  };
}

module.exports = { requireAuth, attachRole, requireRole, configureRolePool };
