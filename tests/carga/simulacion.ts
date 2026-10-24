/* Simulación de carga y consistencia, TODA por el API real (compras, aprobaciones, puerta, permisos).
 *
 *   npm run dev:db      (levanta Postgres de desarrollo)
 *   npm run dev         (API en :4000, en otra terminal)
 *   npm run test:carga
 *
 * SE NIEGA a correr si SUPABASE_URL no es local: nunca contra producción.
 * En desarrollo no hay SMTP ni Gmail configurados, así que no sale ningún correo.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { normalizarTelefono } from "../../src/lib/contacto";

// ---------- entorno y guarda de seguridad ----------
const env: Record<string, string> = {};
for (const l of fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env"), "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0 && !l.startsWith("#")) env[l.slice(0, i)] = l.slice(i + 1);
}
const esLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(env.SUPABASE_URL ?? "");
if (!esLocal) {
  console.error(`✘ SUPABASE_URL=${env.SUPABASE_URL} no es local. Esta simulación solo corre contra el entorno de desarrollo (npm run dev:db).`);
  process.exit(2);
}
const API = (process.env.API_URL ?? `http://127.0.0.1:${env.PORT ?? 4000}`) + "/api";
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ---------- utilidades ----------
type R = { s: number; b: any; ms: number };
const lat: Record<string, number[]> = {};
let ipN = 1;
const nuevaIp = () => `10.${(ipN >> 16) & 255}.${(ipN >> 8) & 255}.${ipN++ & 255}`;
async function call(label: string, ruta: string, o: { method?: string; token?: string; body?: unknown; form?: FormData; ip?: string } = {}): Promise<R> {
  const h: Record<string, string> = { "x-forwarded-for": o.ip ?? nuevaIp() };
  if (o.token) h.authorization = `Bearer ${o.token}`;
  let body: BodyInit | undefined;
  if (o.form) body = o.form; else if (o.body !== undefined) { h["content-type"] = "application/json"; body = JSON.stringify(o.body); }
  const t0 = performance.now();
  const r = await fetch(API + ruta, { method: o.method ?? (body ? "POST" : "GET"), headers: h, body });
  const ms = performance.now() - t0;
  (lat[label] ??= []).push(ms);
  return { s: r.status, b: await r.json().catch(() => ({})), ms };
}
async function pool<T, U>(items: T[], n: number, fn: (x: T, i: number) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
const cuenta = <T>(a: T[], f: (x: T) => string | number) => a.reduce<Record<string, number>>((m, x) => { const k = String(f(x)); m[k] = (m[k] || 0) + 1; return m; }, {});
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const checks: boolean[] = [];
const check = (n: string, ok: boolean, d = "") => { checks.push(ok); console.log(`${ok ? "✔" : "✘"} ${n}${d ? "  — " + d : ""}`); };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const comprobante = () => Buffer.concat([PNG, randomBytes(8)]);
const sufijo = randomBytes(3).toString("hex");
/** Celular boliviano plausible (pasa la misma validación que el API). */
function celular(): string { for (;;) { const n = String(6 + Math.floor(Math.random() * 2)) + String(Math.floor(1e7 + Math.random() * 9e6)).slice(0, 7); if (normalizarTelefono(n)) return n; } }
const token32 = () => randomBytes(24).toString("base64url");
void token32;

async function main() {
  const IP_ADMIN = nuevaIp(); // una IP distinta por corrida: así dos corridas seguidas no comparten el límite de 300 peticiones/min
  // ---------- preparación (por el API) ----------
  const lg = await call("login", "/auth/login", { body: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }, ip: IP_ADMIN });
  if (lg.s !== 200) throw new Error(`No pude entrar como admin (${lg.s}). ¿Corriste «npm run dev» con el .env de desarrollo?`);
  const A = lg.b.token as string;
  const adm = (ruta: string, o: { method?: string; body?: unknown } = {}) => call("admin", ruta, { token: A, ip: IP_ADMIN, ...o });
  const ev = (await adm("/eventos", { body: { nombre: `Simulación ${sufijo}`, lugar: "Santa Cruz", fechaInicio: "2026-10-30T20:00:00-04:00", moneda: "BOB" } })).b;
  for (const [nombre, precio, cupo, categoria] of [["Muerto soltero", 50, 300, "venta"], ["Muerto casado", 50, 40, "venta"], ["Cortesía", 0, 10, "invitacion"]] as const)
    await adm(`/eventos/${ev.id}/tipos`, { body: { nombre, precio, cupo, categoria } });
  const det = (await adm(`/eventos/${ev.id}`)).b;
  const T: Record<string, string> = Object.fromEntries(det.tipos.map((t: any) => [t.nombre, t.id]));
  const staffEmails = [1, 2, 3, 4].map((i) => `sim-staff${i}-${sufijo}@test.local`);
  const rrppEmail = `sim-rrpp-${sufijo}@test.local`;
  const crearU = async (email: string, nombre: string, rol: string) => (await adm("/usuarios", { body: { email, nombre, rol, password: "Simulacion-123" } })).b.id as string;
  const staffIds: string[] = []; for (const [i, e] of staffEmails.entries()) staffIds.push(await crearU(e, `Staff ${i + 1}`, "staff"));
  const rrppId = await crearU(rrppEmail, "RRPP Sim", "rrpp");
  await adm(`/eventos/${ev.id}/equipo`, { method: "PUT", body: { usuarioIds: [...staffIds.slice(0, 3), rrppId] } }); // staff 4 NO asignado
  const login = async (email: string) => (await call("login", "/auth/login", { body: { email, password: "Simulacion-123" } })).b.token as string;
  const st = await Promise.all(staffEmails.map(login)); const rr = await login(rrppEmail);
  console.log(`\nEvento "${ev.nombre}" · 3 staff asignados + 1 sin asignar + 1 RRPP · API ${API}\n`);

  // ---------- A: compradores ----------
  console.log("== A. 150 compradores simultáneos (30 a la vez) ==");
  const compra = (c: { email: string; nombre: string; tipo: string; cant: number; bytes?: Buffer; tel?: string }) => {
    const f = new FormData();
    f.set("nombre", c.nombre); f.set("telefono", c.tel ?? celular()); f.set("email", c.email); f.set("cantidad", String(c.cant)); f.set("tipoTicketId", c.tipo);
    f.set("comprobante", new Blob([new Uint8Array(c.bytes ?? comprobante())], { type: "image/png" }), "c.png");
    return call("compra", `/public/eventos/${ev.slug}/ordenes`, { form: f });
  };
  const compradores: any[] = [];
  for (let i = 0; i < 60; i++) compradores.push({ email: `sim.casado${i}.${sufijo}@gmail.com`, nombre: `Comprador Casado ${i}`, tipo: T["Muerto casado"], cant: 1 });
  for (let i = 0; i < 90; i++) compradores.push({ email: `sim.soltero${i}.${sufijo}@gmail.com`, nombre: `Comprador Soltero ${i}`, tipo: T["Muerto soltero"], cant: 1 + (i % 3) });
  const compartido = comprobante();
  const malos: any[] = [
    ...Array.from({ length: 4 }, (_, i) => ({ email: `sim.falso${i}.${sufijo}@gmail.com`, nombre: "Archivo Falso", tipo: T["Muerto soltero"], cant: 1, bytes: Buffer.from("<script>alert(1)</script>"), esperado: [415] })),
    ...Array.from({ length: 4 }, (_, i) => ({ email: `sim.igual${i}.${sufijo}@gmail.com`, nombre: "Mismo Comprobante", tipo: T["Muerto soltero"], cant: 1, bytes: compartido, esperado: [200, 409] })),
    ...Array.from({ length: 3 }, (_, i) => ({ email: `sim.tel${i}.${sufijo}@gmail.com`, nombre: "Celular Inventado", tipo: T["Muerto soltero"], cant: 1, tel: ["70000000", "71234567", "12345"][i], esperado: [400] })),
    { email: `sim.tipeo.${sufijo}@gmial.com`, nombre: "Correo con error", tipo: T["Muerto soltero"], cant: 1, esperado: [400] },
    { email: `sim.temp.${sufijo}@mailinator.com`, nombre: "Correo desechable", tipo: T["Muerto soltero"], cant: 1, esperado: [400] },
    { email: `sim.nada.${sufijo}@dominio-que-no-existe-zxq-${sufijo}.com`, nombre: "Dominio inexistente", tipo: T["Muerto soltero"], cant: 1, esperado: [400] },
  ];
  const todos = [...compradores, ...malos].sort(() => Math.random() - 0.5);
  const resA = await pool(todos, 30, (c) => compra(c).then((r) => ({ c, r })));
  // Mismo correo que un comprador ya aceptado: se envía DESPUÉS (si no, a veces el «repetido» llegaría primero)
  const repetidos = await pool(Array.from({ length: 4 }), 4, () => compra({ email: `sim.soltero0.${sufijo}@gmail.com`, nombre: "Repetido", tipo: T["Muerto soltero"], cant: 1 }).then((r) => ({ c: { nombre: "Repetido", esperado: [409] } as any, r })));
  resA.push(...repetidos);
  const buenos = resA.filter((x) => !x.c.esperado);
  console.log("   respuestas:", JSON.stringify(cuenta(resA, (x) => x.r.s)));
  check("sin errores de servidor (5xx)", !resA.some((x) => x.r.s >= 500));
  const casadoOk = buenos.filter((x) => x.c.tipo === T["Muerto casado"] && x.r.s === 200).length;
  check("«Muerto casado» (cupo 40) vendido exactamente 40", casadoOk === 40, `${casadoOk} de 60 intentos`);
  check("«Muerto soltero» (cupo 300, 90 compradores): todos entran", buenos.filter((x) => x.c.tipo === T["Muerto soltero"]).every((x) => x.r.s === 200));
  for (const nombre of ["Repetido", "Archivo Falso", "Celular Inventado", "Correo con error", "Correo desechable", "Dominio inexistente"]) {
    const g = resA.filter((x) => x.c.nombre === nombre);
    check(`${nombre}: rechazado (${g[0].c.esperado.join("/")})`, g.every((x) => x.c.esperado.includes(x.r.s)), JSON.stringify(cuenta(g, (x) => x.r.s)));
  }
  const igual = resA.filter((x) => x.c.nombre === "Mismo Comprobante");
  check("mismo comprobante: solo 1 pasa", igual.filter((x) => x.r.s === 200).length === 1, JSON.stringify(cuenta(igual, (x) => x.r.s)));
  const telOk = (await sb.from("ordenes").select("telefono").eq("evento_id", ev.id).limit(5)).data ?? [];
  check("celulares guardados normalizados (+591…)", telOk.length > 0 && telOk.every((o: any) => /^\+591[67]\d{7}$/.test(o.telefono)));

  // ---------- B: aprobar (por el API) ----------
  console.log("\n== B. El administrador aprueba y rechaza (por el API) ==");
  const pend = (await adm(`/ordenes?eventoId=${ev.id}&estado=Pendiente`)).b as any[];
  const aRechazar = pend.slice(0, 8), aAprobar = pend.slice(8);
  const rech = await pool(aRechazar, 4, (o) => adm(`/ordenes/${o.id}/rechazar`, { body: { motivo: "Monto no coincide" } }));
  check("rechazos", rech.every((r) => r.s === 200));
  const dobles = aAprobar.slice(0, 15);
  const resDobles = await Promise.all(dobles.flatMap((o) => [0, 1].map(() => adm(`/ordenes/${o.id}/aprobar`, { body: {} }))));
  const resto = await pool(aAprobar.slice(15), 8, (o) => adm(`/ordenes/${o.id}/aprobar`, { body: {} }));
  const okDobles = resDobles.filter((r) => r.s === 200).length;
  check("doble clic en «Aprobar»: cada orden se aprueba UNA vez", okDobles === dobles.length && resDobles.filter((r) => r.s === 409).length === dobles.length, `${okDobles} aprobaciones / ${dobles.length} órdenes`);
  check("aprobaciones del resto (todas)", resto.every((r) => r.s === 200), JSON.stringify(cuenta(resto, (r) => r.s)));
  const { data: aprob } = await sb.from("ordenes").select("id, cantidad, monto").eq("evento_id", ev.id).eq("estado", "Aprobada");
  const { data: ent } = await sb.from("entradas").select("id, orden_id, tipo_ticket_id, estado, token").eq("evento_id", ev.id);
  const porOrden = cuenta(ent!, (e: any) => e.orden_id);
  check("cada orden aprobada tiene EXACTAMENTE sus entradas", aprob!.every((o: any) => porOrden[o.id] === o.cantidad), `${aprob!.length} órdenes, ${ent!.length} entradas`);

  // ---------- C: permisos y cortesías ----------
  console.log("\n== C. Roles y cortesías ==");
  const emit = await pool(Array.from({ length: 15 }), 15, (_, i) => call("emitir", "/entradas", { token: rr, body: { eventoId: ev.id, tipoTicketId: T["Cortesía"], nombre: `Invitado ${i}` } }));
  check("cortesías: exactamente 10 de 15 intentos simultáneos", emit.filter((r) => r.s === 201).length === 10, JSON.stringify(cuenta(emit, (r) => r.s)));
  check("RRPP no emite tipo «venta»", (await call("emitir", "/entradas", { token: rr, body: { eventoId: ev.id, tipoTicketId: T["Muerto soltero"], nombre: "Intruso" } })).s === 400);
  check("RRPP sin acceso a usuarios (403)", (await call("x", "/usuarios", { token: rr })).s === 403);
  check("staff sin acceso a órdenes (403)", (await call("x", `/ordenes?eventoId=${ev.id}`, { token: st[0] })).s === 403);
  check("staff no puede anular (403)", (await call("x", `/entradas/${(ent as any[])[0].id}/anular`, { token: st[0], body: { motivo: "x" } })).s === 403);
  const anular = (ent as any[]).slice(0, 3);
  await Promise.all(anular.map((e) => adm(`/entradas/${e.id}/anular`, { body: { motivo: "Devolución" } })));

  // ---------- D: puerta ----------
  console.log("\n== D. La puerta: 3 staff, doble escaneo simultáneo ==");
  const { data: filas } = await sb.from("entradas").select("token, estado").eq("evento_id", ev.id);
  const validos = filas!.filter((f: any) => f.estado === "valida").map((f: any) => f.token as string);
  const anulados = filas!.filter((f: any) => f.estado === "anulada").map((f: any) => f.token as string);
  const scan = (tok: string, token: string) => call("scan", "/scan", { token: tok, body: { token } });
  const spare = validos[0];
  check("staff NO asignado: INVÁLIDA y no consume la entrada", (await scan(st[3], spare)).b.estado === "INVALIDA");
  const t0 = performance.now();
  const resD = await pool(validos, 30, async (token, i) => {
    const [a, b] = await Promise.all([scan(st[i % 3], token), scan(st[(i + 1) % 3], token)]);
    return [a.b.estado, b.b.estado].sort().join("+");
  });
  const seg = (performance.now() - t0) / 1000;
  const comb = cuenta(resD, (x) => x);
  check(`${validos.length} entradas × doble escaneo: 1 VÁLIDA + 1 YA_USADA cada una`, Object.keys(comb).length === 1 && comb["VALIDA+YA_USADA"] === validos.length, `${JSON.stringify(comb)} en ${seg.toFixed(1)} s (${((validos.length * 2) / seg).toFixed(0)} escaneos/s)`);
  check("anuladas → ANULADA", (await pool(anulados, 3, (t) => scan(st[0], t))).every((r) => r.b.estado === "ANULADA"));
  check("re-escaneo → YA_USADA con hora", (await pool(validos.slice(0, 30), 10, (t) => scan(st[1], t))).every((r) => r.b.estado === "YA_USADA" && r.b.usadaEn));
  check("código inventado → INVÁLIDA", (await scan(st[0], "Z".repeat(32))).b.estado === "INVALIDA");
  check("sin sesión → 401", (await call("x", "/scan", { body: { token: spare } })).s === 401);

  // ---------- E: consistencia ----------
  console.log("\n== E. Consistencia ==");
  const { data: fin } = await sb.from("entradas").select("estado, usada_en, usada_por").eq("evento_id", ev.id);
  const est = cuenta(fin!, (e: any) => e.estado);
  check("usadas = válidas escaneadas; anuladas intactas", est.usada === validos.length && est.anulada === 3, JSON.stringify(est));
  check("toda entrada usada tiene hora y quién la escaneó", fin!.filter((e: any) => e.estado === "usada").every((e: any) => e.usada_en && e.usada_por));
  const resumen = (await adm(`/eventos/${ev.id}/resumen`)).b;
  const ventas = ((await sb.from("ordenes").select("monto").eq("evento_id", ev.id).eq("estado", "Aprobada")).data ?? []).reduce((s: number, o: any) => s + Number(o.monto), 0);
  check("ventas del panel = suma real de órdenes aprobadas", Number(resumen.ventas) === ventas, `Bs ${resumen.ventas}`);
  check("panel: usados = escaneos válidos", resumen.ticketsUsados === validos.length, `${resumen.ticketsUsados}/${resumen.ticketsEmitidos}`);

  console.log("\n== Latencias contra el API local, ms (n · p50 · p95 · máx) ==");
  for (const [k, v] of Object.entries(lat)) console.log(`${k.padEnd(8)} ${String(v.length).padStart(4)} · ${pct(v, 0.5).toFixed(0).padStart(5)} · ${pct(v, 0.95).toFixed(0).padStart(5)} · ${Math.max(...v).toFixed(0).padStart(5)}`);
  console.log(`\nRESULTADO: ${checks.filter(Boolean).length}/${checks.length} verificaciones OK`);

  // ---------- limpieza (solo la base de desarrollo) ----------
  const { data: ords } = await sb.from("ordenes").select("comprobante_path").eq("evento_id", ev.id);
  const paths = (ords ?? []).map((o: any) => o.comprobante_path as string);
  for (let i = 0; i < paths.length; i += 100) await sb.storage.from("comprobantes").remove(paths.slice(i, i + 100));
  await sb.from("entradas").delete().eq("evento_id", ev.id);
  await sb.from("ordenes").delete().eq("evento_id", ev.id);
  await sb.from("evento_equipo").delete().eq("evento_id", ev.id);
  await sb.from("tipos_ticket").delete().eq("evento_id", ev.id);
  await sb.from("eventos").delete().eq("id", ev.id);
  await sb.from("usuarios").delete().like("email", `sim-%-${sufijo}@test.local`);
  console.log(`limpieza de desarrollo: evento, ${paths.length} comprobantes y usuarios de simulación borrados`);
  process.exit(checks.every(Boolean) ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
