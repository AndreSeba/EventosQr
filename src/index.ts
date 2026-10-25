import { buildApp } from "./app";
import { db } from "./lib/db";
import { hashPassword } from "./lib/seguridad";

/** Crea el primer administrador desde ADMIN_EMAIL / ADMIN_PASSWORD si no hay ningún usuario. */
async function sembrarAdmin(log: { info: (m: string) => void; warn: (m: string) => void }) {
  const { count, error } = await db().from("usuarios").select("id", { count: "exact", head: true });
  if (error) return log.warn(`No se pudo consultar usuarios (¿corriste schema.sql?): ${error.message}`);
  if ((count ?? 0) > 0) return;
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const pass = process.env.ADMIN_PASSWORD;
  if (!email || !pass || pass.length < 8) return log.warn("No hay usuarios y falta ADMIN_EMAIL / ADMIN_PASSWORD (mín. 8 caracteres).");
  // El primer usuario es el dueño del sistema: superadmin, sin organización
  const { error: e2 } = await db().from("usuarios").insert({ email, nombre: "Administrador", rol: "superadmin", password_hash: hashPassword(pass) });
  if (e2) log.warn(`No se pudo crear el admin: ${e2.message}`);
  else log.info(`Administrador inicial creado: ${email}`);
}

/** Render (plan gratis) duerme el servicio tras 15 min sin tráfico entrante. El servidor se visita a sí mismo por su
 *  URL pública (pasa por el balanceador de Render, así que cuenta como tráfico) cada 10 min para no dormirse.
 *  RENDER_EXTERNAL_URL lo define Render solo; KEEP_ALIVE=false lo desactiva. Un monitor externo sigue siendo un buen respaldo. */
function mantenerDespierto(log: { info: (m: string) => void; warn: (m: string) => void }) {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url || process.env.KEEP_ALIVE === "false") return;
  setInterval(() => {
    fetch(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(20_000) }).catch((e) => log.warn(`keep-alive falló: ${e}`));
  }, 10 * 60_000);
  log.info(`keep-alive activo: ${url}/health cada 10 min`);
}

const app = await buildApp();
await sembrarAdmin(app.log);
await app.listen({ port: Number(process.env.PORT ?? 4000), host: "0.0.0.0" });
mantenerDespierto(app.log);
