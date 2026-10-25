import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { esUuid, exigir } from "../auth";
import { db } from "../lib/db";
import { HttpError } from "../lib/errores";
import { hashPassword } from "../lib/seguridad";
import { emailValido } from "../lib/validar";

const slugDe = (nombre: string) =>
  nombre.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";

const crearSchema = z.object({
  nombre: z.string().trim().min(2, "El nombre de la organización es obligatorio.").max(100),
  adminNombre: z.string().trim().min(2, "El nombre del administrador es obligatorio.").max(100),
  adminEmail: z.string().trim().toLowerCase().max(120),
  adminPassword: z.string().min(8, "La contraseña debe tener al menos 8 caracteres.").max(72),
});
const editarSchema = z.object({ nombre: z.string().trim().min(2).max(100), activa: z.boolean() });

/** Gestión de clientes (organizaciones): SOLO el superadmin (dueño del sistema). */
export async function organizacionesRoutes(app: FastifyInstance) {
  const dueno = { preHandler: exigir("superadmin") };

  app.get("/organizaciones", dueno, async () => {
    const [{ data: orgs, error }, { data: eventos }, { data: usuarios }] = await Promise.all([
      db().from("organizaciones").select("*").order("creada_en"),
      db().from("eventos").select("org_id, archivado"),
      db().from("usuarios").select("org_id, activo"),
    ]);
    if (error) throw new Error(error.message);
    return (orgs ?? []).map((o) => ({
      id: o.id, nombre: o.nombre, slug: o.slug, activa: o.activa, creadaEn: o.creada_en,
      eventos: (eventos ?? []).filter((e) => e.org_id === o.id && !e.archivado).length,
      usuarios: (usuarios ?? []).filter((u) => u.org_id === o.id && u.activo).length,
    }));
  });

  // Crea la organización y a su primer administrador. Si el administrador no se puede crear, no queda una organización vacía.
  app.post("/organizaciones", dueno, async (req, reply) => {
    const b = crearSchema.parse(req.body);
    if (!emailValido(b.adminEmail)) throw new HttpError(400, "El correo del administrador no tiene un formato válido.");
    let slug = slugDe(b.nombre);
    const { data: existe } = await db().from("organizaciones").select("id").eq("slug", slug).maybeSingle();
    if (existe) slug = `${slug}-${randomBytes(2).toString("hex")}`;
    const { data: org, error } = await db().from("organizaciones").insert({ nombre: b.nombre, slug }).select("id").single();
    if (error) throw new Error(error.message);
    const { data: adm, error: e2 } = await db()
      .from("usuarios")
      .insert({ org_id: org.id, email: b.adminEmail, nombre: b.adminNombre, rol: "admin", password_hash: hashPassword(b.adminPassword) })
      .select("id")
      .single();
    if (e2) {
      await db().from("organizaciones").delete().eq("id", org.id);
      throw new HttpError(e2.code === "23505" ? 409 : 500, e2.code === "23505" ? "Ya existe un usuario con ese correo." : e2.message);
    }
    reply.code(201);
    return { id: org.id, slug, adminId: adm.id };
  });

  app.put<{ Params: { id: string } }>("/organizaciones/:id", dueno, async (req) => {
    const b = editarSchema.parse(req.body);
    if (!esUuid(req.params.id)) throw new HttpError(404, "Organización no encontrada.");
    const { data, error } = await db().from("organizaciones").update({ nombre: b.nombre, activa: b.activa }).eq("id", req.params.id).select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new HttpError(404, "Organización no encontrada.");
    return { ok: true };
  });
}
