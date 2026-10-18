import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { exigir } from "../auth";
import { db } from "../lib/db";
import { HttpError } from "../lib/errores";
import { hashPassword } from "../lib/seguridad";
import { emailValido } from "../lib/validar";

const password = z.string().min(8, "La contraseña debe tener al menos 8 caracteres.").max(72);
const crearSchema = z.object({
  email: z.string().trim().toLowerCase().max(120),
  nombre: z.string().trim().min(2, "El nombre es obligatorio.").max(100),
  rol: z.enum(["admin", "rrpp", "staff"]),
  password,
});
const editarSchema = z.object({
  nombre: z.string().trim().min(2).max(100),
  rol: z.enum(["admin", "rrpp", "staff"]),
  activo: z.boolean(),
  password: password.optional(),
});

const campos = "id, email, nombre, rol, activo, creado_en";

export async function usuariosRoutes(app: FastifyInstance) {
  const admin = { preHandler: exigir("admin") };

  app.get("/usuarios", admin, async () => {
    const { data, error } = await db().from("usuarios").select(campos).order("nombre");
    if (error) throw new Error(error.message);
    return data.map((u) => ({ id: u.id, email: u.email, nombre: u.nombre, rol: u.rol, activo: u.activo, creadoEn: u.creado_en }));
  });

  app.post("/usuarios", admin, async (req, reply) => {
    const b = crearSchema.parse(req.body);
    if (!emailValido(b.email)) throw new HttpError(400, "El correo no tiene un formato válido.");
    const { data, error } = await db()
      .from("usuarios")
      .insert({ email: b.email, nombre: b.nombre, rol: b.rol, password_hash: hashPassword(b.password) })
      .select("id")
      .single();
    if (error) throw new HttpError(error.code === "23505" ? 409 : 500, error.code === "23505" ? "Ya existe un usuario con ese correo." : error.message);
    reply.code(201);
    return { id: data.id };
  });

  app.put<{ Params: { id: string } }>("/usuarios/:id", admin, async (req) => {
    const b = editarSchema.parse(req.body);
    if (req.params.id === req.usuario.id && (!b.activo || b.rol !== "admin"))
      throw new HttpError(400, "No podés desactivarte ni quitarte el rol de administrador a vos mismo.");
    const cambios: Record<string, unknown> = { nombre: b.nombre, rol: b.rol, activo: b.activo };
    if (b.password) cambios.password_hash = hashPassword(b.password);
    const { data, error } = await db().from("usuarios").update(cambios).eq("id", req.params.id).select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new HttpError(404, "Usuario no encontrado.");
    return { ok: true };
  });
}
