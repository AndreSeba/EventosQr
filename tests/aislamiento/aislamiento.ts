/* Prueba de AISLAMIENTO entre organizaciones (clientes). Actúa como un cliente malicioso: con la sesión de la organización A
 * intenta leer y modificar, ruta por ruta, los recursos de la organización B. Todo debe fallar como si no existieran.
 *
 *   pnpm run dev:db  ·  pnpm run dev  ·  pnpm run test:aislamiento
 *
 * SE NIEGA a correr si SUPABASE_URL no es local. Termina con código 1 si algo se filtra o si queda una ruta AISLADA sin probar.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { AISLADAS, SOLO_SUPERADMIN } from "./cobertura";

const env: Record<string, string> = {};
for (const l of fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env"), "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0 && !l.startsWith("#")) env[l.slice(0, i)] = l.slice(i + 1);
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(env.SUPABASE_URL ?? "")) {
  console.error(`✘ SUPABASE_URL=${env.SUPABASE_URL} no es local. Solo corre contra el entorno de desarrollo.`);
  process.exit(2);
}
const API = (process.env.API_URL ?? `http://127.0.0.1:${env.PORT ?? 4000}`) + "/api";
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

type R = { s: number; b: any };
let ipN = 1;
const ip = () => `10.${(ipN >> 16) & 255}.${(ipN >> 8) & 255}.${ipN++ & 255}`;
async function call(ruta: string, o: { method?: string; token?: string; body?: unknown; form?: FormData } = {}): Promise<R> {
  const h: Record<string, string> = { "x-forwarded-for": ip() };
  if (o.token) h.authorization = `Bearer ${o.token}`;
  let body: BodyInit | undefined;
  if (o.form) body = o.form; else if (o.body !== undefined) { h["content-type"] = "application/json"; body = JSON.stringify(o.body); }
  const r = await fetch(API + ruta, { method: o.method ?? (body ? "POST" : "GET"), headers: h, body });
  return { s: r.status, b: await r.json().catch(() => ({})) };
}

const resultados: boolean[] = [];
const probadas = new Set<string>();
function check(nombre: string, ok: boolean, detalle = "", ruta?: string) {
  resultados.push(ok);
  if (ruta) probadas.add(ruta);
  console.log(`${ok ? "✔" : "✘ FUGA"} ${nombre}${detalle ? "  — " + detalle : ""}`);
}
/** La ruta debe responder 404 (o 403 para rutas de rol) y NO revelar que el recurso existe en otra organización. */
const como404 = (r: R) => r.s === 404;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const sufijo = randomBytes(3).toString("hex");
const celular = () => "7" + String(Math.floor(1e7 + Math.random() * 9e6)).slice(0, 3) + "84" + String(Math.floor(Math.random() * 90) + 10);

async function main() {
  // ============ Preparación: superadmin crea dos organizaciones, cada una con su gente y datos ============
  const su = (await call("/auth/login", { body: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD } })).b.token as string;
  if (!su) throw new Error("No pude entrar como superadmin (revisa el .env de desarrollo y que el API esté corriendo).");
  const PASS = "Aislamiento-123";
  const crearOrg = async (nombre: string, mail: string) => (await call("/organizaciones", { token: su, body: { nombre, adminNombre: `Admin ${nombre}`, adminEmail: mail, adminPassword: PASS } })).b;
  const oA = await crearOrg(`Org A ${sufijo}`, `adm-a-${sufijo}@test.local`);
  const oB = await crearOrg(`Org B ${sufijo}`, `adm-b-${sufijo}@test.local`);
  const login = async (email: string) => (await call("/auth/login", { body: { email, password: PASS } })).b.token as string;
  const tA = await login(`adm-a-${sufijo}@test.local`), tB = await login(`adm-b-${sufijo}@test.local`);

  async function montar(token: string, orgNombre: string, mail: string) {
    const ev = (await call("/eventos", { token, body: { nombre: `Evento ${orgNombre}`, fechaInicio: "2026-12-30T20:00:00-04:00", moneda: "BOB" } })).b;
    await call(`/eventos/${ev.id}/tipos`, { token, body: { nombre: "General", precio: 50, cupo: 100, categoria: "venta" } });
    await call(`/eventos/${ev.id}/tipos`, { token, body: { nombre: "Cortesía", precio: 0, cupo: 10, categoria: "invitacion" } });
    const det = (await call(`/eventos/${ev.id}`, { token })).b;
    const tVenta = det.tipos.find((t: any) => t.nombre === "General").id, tCort = det.tipos.find((t: any) => t.nombre === "Cortesía").id;
    const staffEmail = `staff-${mail}-${sufijo}@test.local`, rrppEmail = `rrpp-${mail}-${sufijo}@test.local`;
    const idStaff = (await call("/usuarios", { token, body: { email: staffEmail, nombre: "Staff", rol: "staff", password: PASS } })).b.id;
    const idRrpp = (await call("/usuarios", { token, body: { email: rrppEmail, nombre: "RRPP", rol: "rrpp", password: PASS } })).b.id;
    await call(`/eventos/${ev.id}/equipo`, { token, method: "PUT", body: { usuarioIds: [idStaff, idRrpp] } });
    const comprar = async (n: number) => {
      const f = new FormData();
      f.set("nombre", `Comprador ${mail}${n}`); f.set("telefono", celular()); f.set("email", `c${n}.${mail}.${sufijo}@gmail.com`);
      f.set("cantidad", "1"); f.set("tipoTicketId", tVenta);
      f.set("comprobante", new Blob([new Uint8Array(Buffer.concat([PNG, randomBytes(8)]))], { type: "image/png" }), "c.png");
      return call(`/public/eventos/${ev.slug}/ordenes`, { form: f });
    };
    for (const n of [1, 2, 3]) await comprar(n);
    const ords = (await call(`/ordenes?eventoId=${ev.id}&estado=Pendiente`, { token })).b as any[];
    await call(`/ordenes/${ords[0].id}/aprobar`, { token, body: {} }); // la 1.ª se aprueba (genera una entrada)
    const entrada = ((await call(`/entradas?eventoId=${ev.id}`, { token })).b as any[])[0];
    const { data: ent } = await sb.from("entradas").select("token").eq("id", entrada.id).single();
    return {
      ev, tVenta, tCort, idStaff, idRrpp, staffEmail, rrppEmail,
      ordenPendiente: ords[1].id as string, ordenPendiente2: ords[2].id as string, ordenAprobada: ords[0].id as string,
      entradaId: entrada.id as string, entradaToken: ent!.token as string,
      tStaff: await login(staffEmail), tRrpp: await login(rrppEmail),
    };
  }
  const A = await montar(tA, "A", "a"), B = await montar(tB, "B", "b");
  console.log(`\nOrganización A (${oA.id.slice(0, 8)}) y B (${oB.id.slice(0, 8)}) creadas, cada una con evento, equipo, órdenes y entradas.\n`);

  // Estado de B antes de los ataques, para comprobar después que NADA cambió
  const fotoB = async () => {
    const [{ data: ev }, { data: tp }, { data: or }, { data: en }, { data: us }] = await Promise.all([
      sb.from("eventos").select("nombre, archivado, descripcion").eq("id", B.ev.id).single(),
      sb.from("tipos_ticket").select("id, precio, cupo, activo").eq("evento_id", B.ev.id).order("id"),
      sb.from("ordenes").select("id, estado").eq("evento_id", B.ev.id).order("id"),
      sb.from("entradas").select("id, estado, anulada_motivo").eq("evento_id", B.ev.id).order("id"),
      sb.from("usuarios").select("id, nombre, rol, activo, org_id").eq("org_id", oB.id).order("id"),
    ]);
    const { data: eq } = await sb.from("evento_equipo").select("usuario_id").eq("evento_id", B.ev.id).order("usuario_id");
    return JSON.stringify({ ev, tp, or, en, us, eq });
  };
  const antes = await fotoB();

  // ============ Controles positivos: cada admin SÍ accede a lo suyo (así los 404 de abajo significan algo) ============
  console.log("== Controles positivos ==");
  check("admin A ve su evento", (await call(`/eventos/${A.ev.id}`, { token: tA })).s === 200);
  check("admin B ve su evento", (await call(`/eventos/${B.ev.id}`, { token: tB })).s === 200);
  check("staff B escanea su propia entrada (VÁLIDA)", (await call("/scan", { token: B.tStaff, body: { token: B.entradaToken } })).b.estado === "VALIDA");
  // se restablece para seguir usando esa entrada de B como objetivo: se crea otra entrada válida de B
  const ords2 = (await call(`/ordenes?eventoId=${B.ev.id}&estado=Pendiente`, { token: tB })).b as any[];
  await call(`/ordenes/${ords2[0].id}/aprobar`, { token: tB, body: {} }); // aprueba una más (queda ordenPendiente2 o ordenPendiente de B)
  void ords2;

  const entradasB = (await call(`/entradas?eventoId=${B.ev.id}&estado=valida`, { token: tB })).b as any[];
  const entradaBvalida = entradasB[0];
  const { data: tokB } = await sb.from("entradas").select("token").eq("id", entradaBvalida.id).single();
  const ordenesBpend = (await call(`/ordenes?eventoId=${B.ev.id}&estado=Pendiente`, { token: tB })).b as any[];
  const ordenBpend = ordenesBpend[0]?.id as string;
  const fotoBase = await fotoB();

  // ============ Ataques: sesión de A contra recursos de B ============
  console.log("\n== Lectura: la organización A intenta leer datos de B ==");
  const eventosA = (await call("/eventos", { token: tA })).b as any[];
  check("GET /eventos: solo aparecen eventos de A", eventosA.length === 1 && eventosA[0].id === A.ev.id, `${eventosA.length} evento(s)`, "GET /api/eventos");
  check("GET /eventos/:id de B → 404", como404(await call(`/eventos/${B.ev.id}`, { token: tA })), "", "GET /api/eventos/:id");
  check("GET /eventos/:id/resumen de B → 404", como404(await call(`/eventos/${B.ev.id}/resumen`, { token: tA })), "", "GET /api/eventos/:id/resumen");
  check("GET /entradas?eventoId=B → 404", como404(await call(`/entradas?eventoId=${B.ev.id}`, { token: tA })), "", "GET /api/entradas");
  check("GET /ordenes?eventoId=B → 404", como404(await call(`/ordenes?eventoId=${B.ev.id}`, { token: tA })));
  const ordenesA = (await call("/ordenes", { token: tA })).b as any[];
  check("GET /ordenes sin filtro: solo órdenes de A", ordenesA.length > 0 && ordenesA.every((o) => o.eventoId === A.ev.id), `${ordenesA.length} orden(es)`, "GET /api/ordenes");
  check("GET /ordenes/:id/comprobante de B → 404", como404(await call(`/ordenes/${ordenBpend}/comprobante`, { token: tA })), "", "GET /api/ordenes/:id/comprobante");
  const usuariosA = (await call("/usuarios", { token: tA })).b as any[];
  check("GET /usuarios: ningún usuario de B", usuariosA.length > 0 && usuariosA.every((u) => u.orgId === oA.id), `${usuariosA.length} usuario(s)`, "GET /api/usuarios");

  console.log("\n== Escritura: A intenta modificar recursos de B ==");
  check("PUT /eventos/:id de B → 404", como404(await call(`/eventos/${B.ev.id}`, { token: tA, method: "PUT", body: { nombre: "HACKEADO", fechaInicio: "2026-12-30T20:00:00-04:00", moneda: "BOB" } })), "", "PUT /api/eventos/:id");
  check("archivar evento de B → 404", como404(await call(`/eventos/${B.ev.id}/archivar`, { token: tA, body: { archivado: true } })), "", "POST /api/eventos/:id/archivar");
  const f = new FormData(); f.set("archivo", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "x.png");
  check("subir imagen al evento de B → 404", como404(await call(`/eventos/${B.ev.id}/imagen?tipo=imagen`, { token: tA, form: f })), "", "POST /api/eventos/:id/imagen");
  check("crear tipo en el evento de B → 404", como404(await call(`/eventos/${B.ev.id}/tipos`, { token: tA, body: { nombre: "Colado", precio: 0, categoria: "venta" } })), "", "POST /api/eventos/:id/tipos");
  check("PUT /tipos/:id de B → 404", como404(await call(`/tipos/${B.tVenta}`, { token: tA, method: "PUT", body: { nombre: "General", precio: 1, cupo: 1, activo: false } })), "", "PUT /api/tipos/:id");
  check("asignar equipo al evento de B → 404", como404(await call(`/eventos/${B.ev.id}/equipo`, { token: tA, method: "PUT", body: { usuarioIds: [] } })), "", "PUT /api/eventos/:id/equipo");
  check("asignar a mi evento un usuario de B → 400", (await call(`/eventos/${A.ev.id}/equipo`, { token: tA, method: "PUT", body: { usuarioIds: [B.idStaff] } })).s === 400);
  check("aprobar orden de B → 404", como404(await call(`/ordenes/${ordenBpend}/aprobar`, { token: tA, body: {} })), "", "POST /api/ordenes/:id/aprobar");
  check("rechazar orden de B → 404", como404(await call(`/ordenes/${ordenBpend}/rechazar`, { token: tA, body: { motivo: "no me gusta" } })), "", "POST /api/ordenes/:id/rechazar");
  check("reenviar correo de orden de B → 404", como404(await call(`/ordenes/${B.ordenAprobada}/reenviar`, { token: tA, body: {} })), "", "POST /api/ordenes/:id/reenviar");
  check("emitir entrada en el evento de B → 404", como404(await call("/entradas", { token: tA, body: { eventoId: B.ev.id, tipoTicketId: B.tCort, nombre: "Colado" } })), "", "POST /api/entradas");
  check("emitir en MI evento con un tipo de B → 400", (await call("/entradas", { token: tA, body: { eventoId: A.ev.id, tipoTicketId: B.tCort, nombre: "Colado" } })).s === 400);
  check("anular entrada de B → 404", como404(await call(`/entradas/${entradaBvalida.id}/anular`, { token: tA, body: { motivo: "sabotaje" } })), "", "POST /api/entradas/:id/anular");
  check("reenviar entrada de B → 404", como404(await call(`/entradas/${entradaBvalida.id}/reenviar`, { token: tA, body: {} })), "", "POST /api/entradas/:id/reenviar");
  check("editar el titular de una entrada de B → 404", como404(await call(`/entradas/${entradaBvalida.id}/titular`, { token: tA, method: "PUT", body: { nombre: "Colado Hackeado" } })), "", "PUT /api/entradas/:id/titular");
  check("editar usuario de B → 404", como404(await call(`/usuarios/${B.idStaff}`, { token: tA, method: "PUT", body: { nombre: "Hackeado", rol: "admin", activo: true, password: "NuevaClave-123" } })), "", "PUT /api/usuarios/:id");
  check("el staff de B NO cambió de contraseña (sigue entrando con la suya)", !!(await login(B.staffEmail)));

  console.log("\n== Intentos de colar la organización en la petición ==");
  const uInj = await call("/usuarios", { token: tA, body: { email: `inj-${sufijo}@test.local`, nombre: "Inyectado", rol: "admin", password: PASS, orgId: oB.id } });
  const { data: inj } = await sb.from("usuarios").select("org_id").eq("email", `inj-${sufijo}@test.local`).single();
  check("POST /usuarios con orgId de B: se crea en MI organización", uInj.s === 201 && inj?.org_id === oA.id, "", "POST /api/usuarios");
  const eInj = await call("/eventos", { token: tA, body: { nombre: "Colado", fechaInicio: "2026-12-30T20:00:00-04:00", moneda: "BOB", orgId: oB.id } });
  const { data: einj } = await sb.from("eventos").select("org_id").eq("id", eInj.b.id).single();
  check("POST /eventos con orgId de B: se crea en MI organización", eInj.s === 201 && einj?.org_id === oA.id, "", "POST /api/eventos");
  check("ids que no son UUID → 404 (no 500)", como404(await call("/eventos/no-es-uuid", { token: tA })) && como404(await call("/usuarios/xyz", { token: tA, method: "PUT", body: { nombre: "xx", rol: "staff", activo: true } })));

  console.log("\n== La puerta ==");
  const e1 = (await call("/scan", { token: A.tStaff, body: { token: tokB!.token } })).b;
  check("staff de A escanea una entrada de B → INVÁLIDA", e1.estado === "INVALIDA", "", "POST /api/scan");
  check("admin de A escanea una entrada de B → INVÁLIDA", (await call("/scan", { token: tA, body: { token: tokB!.token } })).b.estado === "INVALIDA");
  const { data: sigue } = await sb.from("entradas").select("estado").eq("id", entradaBvalida.id).single();
  check("la entrada de B NO se consumió", sigue?.estado === "valida");
  check("staff de A no ve el evento de B (404)", como404(await call(`/eventos/${B.ev.id}`, { token: A.tStaff })));
  check("RRPP de A no emite en el evento de B (404)", como404(await call("/entradas", { token: A.tRrpp, body: { eventoId: B.ev.id, tipoTicketId: B.tCort, nombre: "Colado" } })));

  console.log("\n== Gestión de organizaciones: solo el superadmin ==");
  for (const [m, r, b] of [["GET", "/organizaciones", undefined], ["POST", "/organizaciones", { nombre: "Pirata", adminNombre: "Pirata", adminEmail: "pirata@test.local", adminPassword: PASS }], ["PUT", `/organizaciones/${oB.id}`, { nombre: "Mia", activa: false }]] as const) {
    const x = await call(r, { token: tA, method: m, body: b });
    check(`${m} ${r.replace(oB.id, ":id")} con admin → 403`, x.s === 403, "", `${m} /api${r.replace(oB.id, ":id")}`);
  }
  const { data: orgB } = await sb.from("organizaciones").select("nombre, activa").eq("id", oB.id).single();
  check("la organización B sigue activa y con su nombre", orgB?.activa === true && orgB?.nombre === `Org B ${sufijo}`);

  console.log("\n== Defensa en profundidad: la propia base se niega ==");
  const rpc1 = await sb.rpc("aprobar_orden", { p_id: ordenBpend, p_user: B.idStaff, p_tokens: [randomBytes(24).toString("base64url")], p_org: oA.id });
  check("aprobar_orden(orden de B, org A) → ORDEN_NO_ENCONTRADA", !!rpc1.error && rpc1.error.message.includes("ORDEN_NO_ENCONTRADA"));
  const rpc2 = await sb.rpc("emitir_entradas", { p_evento: B.ev.id, p_tipo: B.tCort, p_nombre: "Colado", p_email: null, p_tokens: [randomBytes(24).toString("base64url")], p_user: B.idStaff, p_org: oA.id });
  check("emitir_entradas(evento de B, org A) → TIPO_INVALIDO", !!rpc2.error && rpc2.error.message.includes("TIPO_INVALIDO"));

  console.log("\n== Nada de B cambió durante todos los ataques ==");
  check("estado completo de la organización B idéntico (evento, tipos, órdenes, entradas, usuarios, equipo)", (await fotoB()) === fotoBase, "");
  void antes;

  console.log("\n== Superadmin: ve todo ==");
  const todos = (await call("/eventos", { token: su })).b as any[];
  check("el superadmin ve los eventos de A y de B", [A.ev.id, B.ev.id].every((id) => todos.some((e) => e.id === id)));
  const orgs = (await call("/organizaciones", { token: su })).b as any[];
  check("GET /organizaciones (superadmin) lista ambas con su conteo", [oA.id, oB.id].every((id) => orgs.some((o) => o.id === id && o.eventos >= 1)), "", "GET /api/organizaciones");
  check("el superadmin puede aprobar una orden de B (control)", (await call(`/ordenes/${ordenBpend}/aprobar`, { token: su, body: {} })).s === 200);

  console.log("\n== Organización desactivada ==");
  await call(`/organizaciones/${oA.id}`, { token: su, method: "PUT", body: { nombre: `Org A ${sufijo}`, activa: false } });
  check("sus usuarios con sesión abierta pierden el acceso (401)", (await call("/eventos", { token: tA })).s === 401 && (await call("/scan", { token: A.tStaff, body: { token: "A".repeat(32) } })).s === 401);
  check("no pueden volver a entrar (401)", (await call("/auth/login", { body: { email: `adm-a-${sufijo}@test.local`, password: PASS } })).s === 401);
  check("su página pública de compra se cierra (404)", (await call(`/public/eventos/${A.ev.slug}`)).s === 404);
  check("la organización B sigue operando", (await call(`/eventos/${B.ev.id}`, { token: tB })).s === 200 && (await call(`/public/eventos/${B.ev.slug}`)).s === 200);
  await call(`/organizaciones/${oA.id}`, { token: su, method: "PUT", body: { nombre: `Org A ${sufijo}`, activa: true } });
  check("al reactivarla, vuelve todo", (await call("/eventos", { token: tA })).s === 200 && (await call(`/public/eventos/${A.ev.slug}`)).s === 200);

  // ============ Cobertura: ninguna ruta AISLADA puede quedar sin probar ============
  const sinProbar = AISLADAS.filter((r) => !probadas.has(r));
  check(`todas las rutas aisladas (${AISLADAS.length}) tienen su prueba de ataque`, sinProbar.length === 0, sinProbar.join(", "));
  const sinProbarSuper = SOLO_SUPERADMIN.filter((r) => !probadas.has(r));
  check(`todas las rutas de superadmin (${SOLO_SUPERADMIN.length}) probadas con un admin`, sinProbarSuper.length === 0, sinProbarSuper.join(", "));

  console.log(`\nRESULTADO: ${resultados.filter(Boolean).length}/${resultados.length} verificaciones OK`);

  // ============ limpieza (solo la base de desarrollo) ============
  for (const org of [oA.id, oB.id]) {
    const { data: evs } = await sb.from("eventos").select("id").eq("org_id", org);
    for (const e of evs ?? []) {
      const { data: ords } = await sb.from("ordenes").select("comprobante_path").eq("evento_id", e.id);
      if (ords?.length) await sb.storage.from("comprobantes").remove(ords.map((o: any) => o.comprobante_path));
      await sb.from("entradas").delete().eq("evento_id", e.id);
      await sb.from("ordenes").delete().eq("evento_id", e.id);
      await sb.from("evento_equipo").delete().eq("evento_id", e.id);
      await sb.from("tipos_ticket").delete().eq("evento_id", e.id);
      await sb.from("eventos").delete().eq("id", e.id);
    }
    await sb.from("usuarios").delete().eq("org_id", org);
    await sb.from("organizaciones").delete().eq("id", org);
  }
  console.log("limpieza de desarrollo: organizaciones de prueba borradas");
  process.exit(resultados.every(Boolean) ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
