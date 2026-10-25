/** Clasificación de TODAS las rutas del API según cómo se protegen. Si agregas una ruta nueva y no la anotas aquí,
 *  `pnpm run test` falla (tests/rutas.test.ts): obliga a pensar en el aislamiento entre organizaciones desde el primer momento. */

/** Sin sesión a propósito: datos públicos del evento y compra. No exponen nada de otras organizaciones. */
export const PUBLICAS = [
  "GET /health",
  "POST /api/auth/login",
  "GET /api/public/eventos/:slug",
  "POST /api/public/eventos/:slug/ordenes",
];

/** Dependen solo del usuario de la sesión (no reciben ids de otros recursos). */
export const PROPIAS = ["GET /api/auth/me", "POST /api/auth/cambiar-password"];

/** Solo el superadmin (dueño del sistema). Se prueba que un admin de una organización reciba 403. */
export const SOLO_SUPERADMIN = ["GET /api/organizaciones", "POST /api/organizaciones", "PUT /api/organizaciones/:id"];

/** Reciben ids o filtros de recursos que pertenecen a una organización: cada una se prueba con la sesión de OTRA organización
 *  (tests/aislamiento/aislamiento.ts) y debe responder como si el recurso no existiera. */
export const AISLADAS = [
  "GET /api/eventos",
  "POST /api/eventos",
  "GET /api/eventos/:id",
  "PUT /api/eventos/:id",
  "POST /api/eventos/:id/archivar",
  "POST /api/eventos/:id/imagen",
  "POST /api/eventos/:id/tipos",
  "PUT /api/tipos/:id",
  "PUT /api/eventos/:id/equipo",
  "GET /api/eventos/:id/resumen",
  "GET /api/ordenes",
  "GET /api/ordenes/:id/comprobante",
  "POST /api/ordenes/:id/aprobar",
  "POST /api/ordenes/:id/rechazar",
  "POST /api/ordenes/:id/reenviar",
  "GET /api/entradas",
  "POST /api/entradas",
  "POST /api/entradas/:id/anular",
  "POST /api/entradas/:id/reenviar",
  "GET /api/usuarios",
  "POST /api/usuarios",
  "PUT /api/usuarios/:id",
  "POST /api/scan",
];

export const TODAS = [...PUBLICAS, ...PROPIAS, ...SOLO_SUPERADMIN, ...AISLADAS];
