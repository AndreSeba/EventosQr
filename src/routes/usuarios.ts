import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { esUuid, exigir } from "../auth";
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
  orgId: z.string().uuid().optional(), // solo lo usa el superadmin (el admin crea siempre en SU organización)
});
const editarSchema = z.object({
  nombre: z.string().trim().min(2).max(100),
  rol: z.enum(["superadmin", "admin", "rrpp", "staff"]),
  activo: z.boolean(),
  password: password.optional(),
});

export async function usuariosRoutes(app: FastifyInstance) {
  const admin = { preHandler: exigir("admin") };

  // El admin ve SOLO a la gente de su organización; el superadmin ve a todos (y puede filtrar con ?orgId=).
  app.get<{ Querystring: { orgId?: string } }>("/usuarios", admin, async (req) => {
    let q = db().from("usuarios").select("id, email, nombre, rol, activo, creado_en, org_id, organizaciones(nombre)").order("nombre");
    if (req.usuario.rol === "superadmin") {
      if (req.query.orgId) q = q.eq("org_id", req.query.orgId);
    } else {
      q = q.eq("org_id", req.usuario.orgId!);
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data.map((u) => {
      const o = Array.isArray(u.organizaciones) ? u.organizaciones[0] : u.organizaciones;
      return { id: u.id, email: u.email, nombre: u.nombre, rol: u.rol, activo: u.activo, creadoEn: u.creado_en, orgId: u.org_id, organizacion: o?.nombre ?? null };
    });
  });

  app.post("/usuarios", admin, async (req, reply) => {
    const b = crearSchema.parse(req.body);
    if (!emailValido(b.email)) throw new HttpError(400, "El correo no tiene un formato válido.");
    const orgId = req.usuario.rol === "superadmin" ? b.orgId : req.usuario.orgId;
    if (!esUuid(orgId)) throw new HttpError(400, "Indicá la organización del usuario.");
    const { data: org } = await db().from("organizaciones").select("activa").eq("id", orgId).maybeSingle();
    if (!org) throw new HttpError(400, "La organización no existe.");
    const { data, error } = await db()
      .from("usuarios")
      .insert({ org_id: orgId, email: b.email, nombre: b.nombre, rol: b.rol, password_hash: hashPassword(b.password) })
      .select("id")
      .single();
    if (error) throw new HttpError(error.code === "23505" ? 409 : 500, error.code === "23505" ? "Ya existe un usuario con ese correo." : error.message);
    reply.code(201);
    return { id: data.id };
  });

  app.put<{ Params: { id: string } }>("/usuarios/:id", admin, async (req) => {
    const b = editarSchema.parse(req.body);
    if (!esUuid(req.params.id)) throw new HttpError(404, "Usuario no encontrado.");
    const { data: objetivo } = await db().from("usuarios").select("id, rol, org_id").eq("id", req.params.id).maybeSingle();
    // Un usuario de otra organización responde igual que uno inexistente (el admin tampoco ve a los superadmin)
    const visible = objetivo && (req.usuario.rol === "superadmin" || (objetivo.org_id === req.usuario.orgId && objetivo.rol !== "superadmin"));
    if (!objetivo || !visible) throw new HttpError(404, "Usuario no encontrado.");
    if ((objetivo.rol === "superadmin") !== (b.rol === "superadmin"))
      throw new HttpError(400, "El rol de superadministrador no se puede asignar ni quitar desde aquí.");
    if (req.params.id === req.usuario.id && (!b.activo || b.rol !== req.usuario.rol))
      throw new HttpError(400, "No podés desactivarte ni cambiarte el rol a vos mismo.");
    const cambios: Record<string, unknown> = { nombre: b.nombre, rol: b.rol, activo: b.activo };
    if (b.password) cambios.password_hash = hashPassword(b.password);
    const { data, error } = await db().from("usuarios").update(cambios).eq("id", req.params.id).select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new HttpError(404, "Usuario no encontrado.");
    return { ok: true };
  });
}
