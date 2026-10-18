import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { exigir } from "../auth";
import { requerido } from "../lib/config";
import { db } from "../lib/db";
import { HttpError } from "../lib/errores";
import { limitar } from "../lib/ratelimit";
import { crearToken, hashPassword, HASH_RELLENO, verificarPassword } from "../lib/seguridad";

const loginSchema = z.object({ email: z.string().trim().toLowerCase().max(120), password: z.string().min(1).max(200) });
const cambioSchema = z.object({
  actual: z.string().min(1).max(200),
  nueva: z.string().min(8, "La contraseña nueva debe tener al menos 8 caracteres.").max(72),
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/login", async (req) => {
    const { email, password } = loginSchema.parse(req.body);
    if (!limitar(`login:ip:${req.ip}`, 10, 10 * 60_000) || !limitar(`login:mail:${email}`, 8, 10 * 60_000))
      throw new HttpError(429, "Demasiados intentos. Esperá unos minutos.");

    const { data } = await db().from("usuarios").select("id, email, nombre, rol, activo, password_hash").ilike("email", email).maybeSingle();
    // Siempre se verifica un hash, exista o no el usuario, para igualar tiempos.
    const ok = verificarPassword(password, data?.password_hash ?? HASH_RELLENO);
    if (!data || !data.activo || !ok) throw new HttpError(401, "Correo o contraseña incorrectos.");
    return {
      token: crearToken(data.id, requerido("JWT_SECRET")),
      usuario: { id: data.id, email: data.email, nombre: data.nombre, rol: data.rol },
    };
  });

  app.get("/auth/me", { preHandler: exigir() }, async (req) => ({ usuario: req.usuario }));

  app.post("/auth/cambiar-password", { preHandler: exigir() }, async (req) => {
    const { actual, nueva } = cambioSchema.parse(req.body);
    const { data } = await db().from("usuarios").select("password_hash").eq("id", req.usuario.id).single();
    if (!data || !verificarPassword(actual, data.password_hash)) throw new HttpError(400, "La contraseña actual no es correcta.");
    await db().from("usuarios").update({ password_hash: hashPassword(nueva) }).eq("id", req.usuario.id);
    return { ok: true };
  });
}
