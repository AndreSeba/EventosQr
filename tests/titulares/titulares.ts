/* Prueba del TITULAR POR ENTRADA: cédula y acompañantes opcionales al comprar, numeración dentro de la orden, edición por el comprador
 * y por el administrador, transferencia (QR nuevo, el viejo muere) y lo que ve el escáner.
 *
 *   pnpm run dev:db  ·  pnpm run dev  ·  pnpm run test:titulares
 *
 * SE NIEGA a correr si SUPABASE_URL no es local.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

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
function check(nombre: string, ok: boolean, detalle = "") {
  resultados.push(ok);
  console.log(`${ok ? "✔" : "✘ FALLA"} ${nombre}${detalle ? "  — " + detalle : ""}`);
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const sufijo = randomBytes(3).toString("hex");
const celular = () => "7" + String(Math.floor(1e7 + Math.random() * 9e6)).slice(0, 3) + "84" + String(Math.floor(Math.random() * 90) + 10);

async function main() {
  const su = (await call("/auth/login", { body: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD } })).b.token as string;
  if (!su) throw new Error("No pude entrar como superadmin (revisa el .env de desarrollo y que el API esté corriendo).");
  const PASS = "Titulares-123";
  const org = (await call("/organizaciones", { token: su, body: { nombre: `Org Titulares ${sufijo}`, adminNombre: "Admin Titulares", adminEmail: `adm-${sufijo}@test.local`, adminPassword: PASS } })).b;
  const login = async (email: string) => (await call("/auth/login", { body: { email, password: PASS } })).b.token as string;
  const tAdm = await login(`adm-${sufijo}@test.local`);

  const montarEvento = async (nombre: string, fecha: string) => {
    const ev = (await call("/eventos", { token: tAdm, body: { nombre, fechaInicio: fecha, moneda: "BOB" } })).b;
    await call(`/eventos/${ev.id}/tipos`, { token: tAdm, body: { nombre: "General", precio: 50, cupo: 100, categoria: "venta" } });
    await call(`/eventos/${ev.id}/tipos`, { token: tAdm, body: { nombre: "Invitación", precio: 0, cupo: 20, categoria: "invitacion" } });
    const det = (await call(`/eventos/${ev.id}`, { token: tAdm })).b;
    return { ev, tVenta: det.tipos.find((t: any) => t.nombre === "General").id as string, tInv: det.tipos.find((t: any) => t.nombre === "Invitación").id as string };
  };
  const { ev, tVenta, tInv } = await montarEvento(`Evento Titulares ${sufijo}`, "2026-12-30T20:00:00-04:00");
  const rrppEmail = `rrpp-${sufijo}@test.local`;
  const idRrpp = (await call("/usuarios", { token: tAdm, body: { email: rrppEmail, nombre: "RRPP", rol: "rrpp", password: PASS } })).b.id;
  await call(`/eventos/${ev.id}/equipo`, { token: tAdm, method: "PUT", body: { usuarioIds: [idRrpp] } });
  const staffEmail = `staff-${sufijo}@test.local`;
  const idStaff = (await call("/usuarios", { token: tAdm, body: { email: staffEmail, nombre: "Staff", rol: "staff", password: PASS } })).b.id;
  await call(`/eventos/${ev.id}/equipo`, { token: tAdm, method: "PUT", body: { usuarioIds: [idRrpp, idStaff] } });
  const tRrpp = await login(rrppEmail), tStaff = await login(staffEmail);

  const comprar = async (slug: string, tipo: string, n: number, cantidad: number, titulares?: unknown) => {
    const f = new FormData();
    f.set("nombre", `Comprador ${n}`); f.set("telefono", celular()); f.set("email", `t${n}.${sufijo}@gmail.com`);
    f.set("cantidad", String(cantidad)); f.set("tipoTicketId", tipo);
    if (titulares !== undefined) f.set("titulares", typeof titulares === "string" ? titulares : JSON.stringify(titulares));
    f.set("comprobante", new Blob([new Uint8Array(Buffer.concat([PNG, randomBytes(8)]))], { type: "image/png" }), "c.png");
    return call(`/public/eventos/${slug}/ordenes`, { form: f });
  };
  const ordenPorNumero = async (numero: number) => (await sb.from("ordenes").select("id, acceso, titulares").eq("numero", numero).single()).data!;
  const entradasDe = async (ordenId: string) => (await sb.from("entradas").select("id, nombre, ci, token, estado, numero_en_orden, titular_definido, transferencias").eq("orden_id", ordenId).order("numero_en_orden")).data!;

  console.log("\n== 1. Comprar con cédula y acompañantes (todo opcional) ==");
  const rA = await comprar(ev.slug, tVenta, 1, 3, [{ ci: "1234567" }, { nombre: "Luis Rojas", ci: "7654321-1A" }, {}]);
  check("compra de 3 entradas con datos de acompañantes → 200", rA.s === 200, JSON.stringify(rA.b));
  const rB = await comprar(ev.slug, tVenta, 2, 2);
  check("compra de 2 entradas SIN datos de acompañantes → 200 (todo es opcional)", rB.s === 200);
  const rC = await comprar(ev.slug, tVenta, 3, 1, [{ ci: "x" }]);
  check("cédula mal escrita → 400 (se avisa antes de guardar)", rC.s === 400, rC.b?.error ?? "");
  const rD = await comprar(ev.slug, tVenta, 4, 2, "esto no es json");
  check("datos de acompañantes ilegibles → 400", rD.s === 400);
  const rE = await comprar(ev.slug, tVenta, 5, 2, [{}, {}, {}]);
  check("más acompañantes que entradas → 400", rE.s === 400);
  const rF = await comprar(ev.slug, tVenta, 6, 2, [{ nombre: "A" }, {}]);
  check("nombre de acompañante demasiado corto → 400", rF.s === 400);

  const oA = await ordenPorNumero(rA.b.numero), oB = await ordenPorNumero(rB.b.numero);
  const sinOrdenC = await sb.from("ordenes").select("id").eq("email", `t3.${sufijo}@gmail.com`);
  check("la orden rechazada por datos inválidos NO se creó", (sinOrdenC.data ?? []).length === 0);
  check("la orden sin datos de acompañantes no guarda titulares", oB.titulares === null);

  console.log("\n== 2. Al aprobar: numeración y titulares ==");
  check("aprobar orden A → 200", (await call(`/ordenes/${oA.id}/aprobar`, { token: tAdm, body: {} })).s === 200);
  check("aprobar orden B → 200", (await call(`/ordenes/${oB.id}/aprobar`, { token: tAdm, body: {} })).s === 200);
  const eA = await entradasDe(oA.id), eB = await entradasDe(oB.id);
  check("orden A: entradas numeradas 1, 2, 3", eA.map((e) => e.numero_en_orden).join() === "1,2,3", eA.map((e) => e.numero_en_orden).join());
  check("orden A: la 2.ª lleva el nombre del acompañante y las otras el del comprador", eA[0].nombre === "Comprador 1" && eA[1].nombre === "Luis Rojas" && eA[2].nombre === "Comprador 1", eA.map((e) => e.nombre).join(" | "));
  check("orden A: cédulas 1234567 / 7654321-1A / ninguna", eA[0].ci === "1234567" && eA[1].ci === "7654321-1A" && eA[2].ci === null, eA.map((e) => e.ci).join(" | "));
  check("orden A: titular definido = sí, sí, no (la 3.ª no tiene nombre propio)", eA.map((e) => e.titular_definido).join() === "true,true,false");
  check("orden B: 1.ª definida, 2.ª sin nombre propio", eB.map((e) => e.titular_definido).join() === "true,false" && eB.every((e) => e.ci === null));
  const inv = await call("/entradas", { token: tAdm, body: { eventoId: ev.id, tipoTicketId: tInv, nombre: "Invitado Manual" } });
  const { data: filaInv } = await sb.from("entradas").select("numero_en_orden, titular_definido").eq("id", inv.b.ids[0]).single();
  check("invitación manual: sin número de orden y con titular definido", filaInv?.numero_en_orden === null && filaInv?.titular_definido === true);

  console.log("\n== 3. Link de la orden: lo que ve el comprador ==");
  const pub = (await call(`/public/ordenes/${oA.acceso}`)).b;
  check("muestra las 3 entradas con su número, titular y cédula parcial", pub.entradas?.length === 3 && pub.entradas.map((e: any) => e.n).join() === "1,2,3" && pub.entradas[1].nombre === "Luis Rojas" && pub.entradas[0].ciParcial === "•••567" && pub.entradas[1].ciParcial === "•••-1A" && pub.entradas[2].ciParcial === null, JSON.stringify(pub.entradas?.map((e: any) => [e.n, e.nombre, e.ciParcial, e.titularDefinido])));
  check("la cédula NO viaja entera por el link", !JSON.stringify(pub).includes("7654321") && !JSON.stringify(pub).includes("1234567"), pub.entradas?.map((e: any) => e.ciParcial).join(" | "));
  check("todas editables (evento futuro, entradas vigentes)", pub.entradas?.every((e: any) => e.editable === true));

  console.log("\n== 4. El comprador corrige un titular ==");
  const url = (n: number, extra = "") => `/public/ordenes/${oA.acceso}/entradas/${n}${extra}`;
  const p1 = await call(url(3), { method: "PUT", body: { nombre: "María Gómez", ci: "11112222" } });
  check("corregir nombre y cédula de la entrada 3 → 200", p1.s === 200, JSON.stringify(p1.b));
  const e3 = (await entradasDe(oA.id))[2];
  check("quedó guardado y la entrada pasa a «titular definido»", e3.nombre === "María Gómez" && e3.ci === "11112222" && e3.titular_definido === true);
  check("el QR NO cambió al corregir datos", e3.token === eA[2].token);
  check("cédula inválida → 400", (await call(url(3), { method: "PUT", body: { ci: "!!" } })).s === 400);
  check("sin nada para cambiar → 400", (await call(url(3), { method: "PUT", body: {} })).s === 400);
  check("borrar solo la cédula (ci vacía) → 200 y queda sin cédula", (await call(url(3), { method: "PUT", body: { ci: "" } })).s === 200 && (await entradasDe(oA.id))[2].ci === null);
  check("entrada que no existe en la orden → 404", (await call(url(9), { method: "PUT", body: { nombre: "Nadie Nadie" } })).s === 404);
  check("token de orden equivocado → 404", (await call(`/public/ordenes/${"a".repeat(64)}/entradas/1`, { method: "PUT", body: { nombre: "Nadie Nadie" } })).s === 404);
  check("el link de OTRA orden no toca esta (404 por número fuera de rango)", (await call(`/public/ordenes/${oB.acceso}/entradas/3`, { method: "PUT", body: { nombre: "Nadie Nadie" } })).s === 404);
  const { data: cambios } = await sb.from("entrada_cambios").select("por, tipo, nombre_anterior, nombre_nuevo").eq("entrada_id", e3.id);
  check("quedó el registro de los cambios (por «comprador»)", (cambios ?? []).length >= 2 && cambios!.every((c) => c.por === "comprador"));

  console.log("\n== 5. Transferir: QR nuevo, el anterior muere ==");
  const e2antes = (await entradasDe(oA.id))[1];
  const t1 = await call(url(2, "/transferir"), { body: { nombre: "Pedro Vargas", ci: "9998887" } });
  check("transferir la entrada 2 → 200", t1.s === 200, JSON.stringify(t1.b));
  const e2 = (await entradasDe(oA.id))[1];
  check("el token cambió y el titular es el nuevo", e2.token !== e2antes.token && e2.nombre === "Pedro Vargas" && e2.ci === "9998887" && e2.transferencias === 1);
  const escVieja = (await call("/scan", { token: tStaff, body: { token: e2antes.token } })).b;
  check("escanear el QR VIEJO → INVÁLIDA", escVieja.estado === "INVALIDA");
  const escNueva = (await call("/scan", { token: tStaff, body: { token: e2.token } })).b;
  check("escanear el QR NUEVO → VÁLIDA con «Entrada 2 de 3», nombre y cédula", escNueva.estado === "VALIDA" && escNueva.nombre === "Pedro Vargas" && escNueva.numeroEnOrden === 2 && escNueva.totalOrden === 3 && escNueva.ci === "9998887" && escNueva.titularDefinido === true, JSON.stringify(escNueva));
  const escOtra = (await call("/scan", { token: tStaff, body: { token: eA[0].token } })).b;
  check("la entrada 1 (sin transferir) → VÁLIDA y conserva su cédula", escOtra.estado === "VALIDA" && escOtra.numeroEnOrden === 1 && escOtra.ci === "1234567");
  const e3b = (await entradasDe(oA.id))[2];
  void e3b;
  const escDos = (await call("/scan", { token: tStaff, body: { token: e2.token } })).b;
  check("escanear el QR nuevo otra vez → YA USADA (con número y cédula para comparar)", escDos.estado === "YA_USADA" && escDos.numeroEnOrden === 2 && escDos.ci === "9998887");
  check("una entrada ya usada NO se puede corregir ni transferir (409)", (await call(url(2), { method: "PUT", body: { nombre: "Otro Nombre" } })).s === 409 && (await call(url(2, "/transferir"), { body: { nombre: "Otro Nombre" } })).s === 409);
  check("transferir sin nombre → 400", (await call(url(3, "/transferir"), { body: { nombre: "" } })).s === 400);

  console.log("\n== 6. Tope de transferencias ==");
  const urlB = (extra = "") => `/public/ordenes/${oB.acceso}/entradas/2${extra}`;
  const codigos: number[] = [];
  for (let i = 1; i <= 4; i++) codigos.push((await call(urlB("/transferir"), { body: { nombre: `Receptor ${i}` } })).s);
  check("3 transferencias → 200 y la 4.ª → 409", codigos.join() === "200,200,200,409", codigos.join());

  console.log("\n== 7. El administrador corrige un titular ==");
  const eB1 = (await entradasDe(oB.id))[0];
  const a1 = await call(`/entradas/${eB1.id}/titular`, { token: tAdm, method: "PUT", body: { nombre: "Ana Pérez Corregida", ci: "5550001" } });
  check("admin corrige nombre y cédula → 200", a1.s === 200, JSON.stringify(a1.b));
  const eB1b = (await entradasDe(oB.id))[0];
  check("quedó guardado", eB1b.nombre === "Ana Pérez Corregida" && eB1b.ci === "5550001");
  const { data: cAdm } = await sb.from("entrada_cambios").select("por, nombre_anterior").eq("entrada_id", eB1.id);
  check("el registro dice QUIÉN lo cambió y cómo estaba antes", cAdm?.length === 1 && cAdm[0].por === "Admin Titulares" && cAdm[0].nombre_anterior === "Comprador 2", JSON.stringify(cAdm));
  check("el RRPP NO puede (403)", (await call(`/entradas/${eB1.id}/titular`, { token: tRrpp, method: "PUT", body: { nombre: "Colado Hackeado" } })).s === 403);
  check("el staff NO puede (403)", (await call(`/entradas/${eB1.id}/titular`, { token: tStaff, method: "PUT", body: { nombre: "Colado Hackeado" } })).s === 403);
  check("cédula inválida → 400", (await call(`/entradas/${eB1.id}/titular`, { token: tAdm, method: "PUT", body: { ci: "$$" } })).s === 400);
  check("sin sesión → 401", (await call(`/entradas/${eB1.id}/titular`, { method: "PUT", body: { nombre: "Colado Hackeado" } })).s === 401);

  console.log("\n== 8. Listado del equipo ==");
  const lista = (await call(`/entradas?eventoId=${ev.id}`, { token: tStaff })).b as any[];
  const delA = lista.filter((e) => e.ordenNumero === rA.b.numero).sort((x, y) => x.numeroEnOrden - y.numeroEnOrden);
  check("GET /entradas trae orden, «n de N», cédula y si el titular es propio", delA.length === 3 && delA[1].totalOrden === 3 && delA[1].ci === "9998887" && delA[2].titularDefinido === true);
  check("la invitación manual sale sin número de orden", lista.some((e) => e.nombre === "Invitado Manual" && e.ordenNumero === null && e.numeroEnOrden === null));

  console.log("\n== 9. Evento que ya empezó ==");
  const pasado = await montarEvento(`Evento Pasado ${sufijo}`, "2026-01-10T20:00:00-04:00");
  const rP = await comprar(pasado.ev.slug, pasado.tVenta, 7, 2);
  const oP = await ordenPorNumero(rP.b.numero);
  await call(`/ordenes/${oP.id}/aprobar`, { token: tAdm, body: {} });
  const pubP = (await call(`/public/ordenes/${oP.acceso}`)).b;
  check("las entradas figuran como NO editables", pubP.entradas?.length === 2 && pubP.entradas.every((e: any) => e.editable === false));
  check("corregir → 409", (await call(`/public/ordenes/${oP.acceso}/entradas/2`, { method: "PUT", body: { nombre: "Tarde Tarde" } })).s === 409);
  check("transferir → 409", (await call(`/public/ordenes/${oP.acceso}/entradas/2/transferir`, { body: { nombre: "Tarde Tarde" } })).s === 409);
  check("el administrador SÍ puede corregir igual", (await call(`/entradas/${(await entradasDe(oP.id))[1].id}/titular`, { token: tAdm, method: "PUT", body: { nombre: "Corregida En Puerta" } })).s === 200);

  console.log(`\nRESULTADO: ${resultados.filter(Boolean).length}/${resultados.length} verificaciones OK`);

  // ============ limpieza (solo la base de desarrollo) ============
  const { data: evs } = await sb.from("eventos").select("id").eq("org_id", org.id);
  for (const e of evs ?? []) {
    const { data: ords } = await sb.from("ordenes").select("comprobante_path").eq("evento_id", e.id);
    if (ords?.length) await sb.storage.from("comprobantes").remove(ords.map((o: any) => o.comprobante_path));
    const { data: ents } = await sb.from("entradas").select("id").eq("evento_id", e.id);
    if (ents?.length) await sb.from("entrada_cambios").delete().in("entrada_id", ents.map((x: any) => x.id));
    await sb.from("entradas").delete().eq("evento_id", e.id);
    await sb.from("ordenes").delete().eq("evento_id", e.id);
    await sb.from("evento_equipo").delete().eq("evento_id", e.id);
    await sb.from("tipos_ticket").delete().eq("evento_id", e.id);
    await sb.from("eventos").delete().eq("id", e.id);
  }
  await sb.from("usuarios").delete().eq("org_id", org.id);
  await sb.from("organizaciones").delete().eq("id", org.id);
  console.log("limpieza de desarrollo: organización de prueba borrada");
  process.exit(resultados.every(Boolean) ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });