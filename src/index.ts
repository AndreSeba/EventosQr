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
  const { error: e2 } = await db().from("usuarios").insert({ email, nombre: "Administrador", rol: "admin", password_hash: hashPassword(pass) });
  if (e2) log.warn(`No se pudo crear el admin: ${e2.message}`);
  else log.info(`Administrador inicial creado: ${email}`);
}

const app = await buildApp();
await sembrarAdmin(app.log);
await app.listen({ port: Number(process.env.PORT ?? 4000), host: "0.0.0.0" });
