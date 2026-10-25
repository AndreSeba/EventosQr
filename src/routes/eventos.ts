import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eventosDe, exigir, exigirEvento, exigirTipo, esUuid } from "../auth";
import { db, BUCKET_PUBLICO, urlPublica } from "../lib/db";
import { HttpError } from "../lib/errores";
import { leerFormulario } from "../lib/multipart";
import { detectarTipo } from "../lib/validar";
import { frontendUrl } from "../lib/config";

const texto = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => v || null);
const eventoSchema = z.object({
  nombre: z.string().trim().min(2, "El nombre es obligatorio.").max(120),
  descripcion: texto(1000),
  lugar: texto(150),
  direccionUrl: texto(500).refine((v) => !v || /^https?:\/\//.test(v), "La dirección debe ser un enlace http(s)."),
  fechaInicio: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Fecha inválida."),
  moneda: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Moneda de 3 letras (ej. BOB).").default("BOB"),
});
const tipoSchema = z.object({
  nombre: z.string().trim().min(2).max(60),
  precio: z.coerce.number().min(0).max(1_000_000),
  cupo: z.coerce.number().int().positive().max(100_000).nullable().optional(),
  categoria: z.enum(["venta", "invitacion", "vip"]).default("venta"),
  activo: z.boolean().default(true),
});

const slugDe = (nombre: string) =>
  nombre.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 55) || "evento";

const salida = (e: Record<string, any>) => ({
  id: e.id, slug: e.slug, nombre: e.nombre, descripcion: e.descripcion, lugar: e.lugar, direccionUrl: e.direccion_url,
  fechaInicio: e.fecha_inicio, moneda: e.moneda, archivado: e.archivado,
  imagenUrl: urlPublica(e.imagen_path), qrPagoUrl: urlPublica(e.qr_pago_path),
  linkVenta: `${frontendUrl()}/e/${e.slug}`,
  organizacion: (Array.isArray(e.organizaciones) ? e.organizaciones[0]?.nombre : e.organizaciones?.nombre) ?? null,
});

export async function eventosRoutes(app: FastifyInstance) {
  const admin = { preHandler: exigir("admin") };
  const miembro = { preHandler: exigir("admin", "rrpp", "staff") };

  app.get<{ Querystring: { archivados?: string } }>("/eventos", miembro, async (req) => {
    const permitidos = await eventosDe(req.usuario);
    let q = db().from("eventos").select("*, organizaciones(nombre)").eq("archivado", req.query.archivados === "true").order("fecha_inicio", { ascending: false });
    if (permitidos) q = q.in("id", permitidos.length ? permitidos : ["00000000-0000-0000-0000-000000000000"]);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data.map(salida);
  });

  app.post("/eventos", admin, async (req, reply) => {
    const b = eventoSchema.parse(req.body);
    // El admin crea eventos en SU organización; el superadmin debe indicar en cuál (orgId).
    const orgId = req.usuario.rol === "superadmin" ? (req.body as { orgId?: string } | null)?.orgId : req.usuario.orgId;
    if (!esUuid(orgId)) throw new HttpError(400, "Indicá la organización del evento.");
    const { data: org } = await db().from("organizaciones").select("activa").eq("id", orgId).maybeSingle();
    if (!org?.activa) throw new HttpError(400, "La organización no existe o está desactivada.");
    const { data, error } = await db()
      .from("eventos")
      .insert({
        org_id: orgId,
        slug: `${slugDe(b.nombre)}-${randomBytes(3).toString("hex")}`,
        nombre: b.nombre, descripcion: b.descripcion, lugar: b.lugar, direccion_url: b.direccionUrl,
        fecha_inicio: new Date(b.fechaInicio).toISOString(), moneda: b.moneda,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    reply.code(201);
    return salida(data);
  });

  app.get<{ Params: { id: string } }>("/eventos/:id", miembro, async (req) => {
    await exigirEvento(req.usuario, req.params.id);
    const { data: ev } = await db().from("eventos").select("*").eq("id", req.params.id).maybeSingle();
    if (!ev) throw new HttpError(404, "Evento no encontrado.");
    const { data: tipos } = await db().from("tipos_ticket").select("*").eq("evento_id", ev.id).order("creado_en");
    const { data: equipo } = await db().from("evento_equipo").select("usuario_id").eq("evento_id", ev.id);
    return {
      ...salida(ev),
      tipos: (tipos ?? []).map((t) => ({ id: t.id, nombre: t.nombre, precio: Number(t.precio), cupo: t.cupo, categoria: t.categoria, activo: t.activo })),
      equipoIds: (equipo ?? []).map((r) => r.usuario_id),
    };
  });

  app.put<{ Params: { id: string } }>("/eventos/:id", admin, async (req) => {
    await exigirEvento(req.usuario, req.params.id);
    const b = eventoSchema.parse(req.body);
    const { data, error } = await db()
      .from("eventos")
      .update({ nombre: b.nombre, descripcion: b.descripcion, lugar: b.lugar, direccion_url: b.direccionUrl, fecha_inicio: new Date(b.fechaInicio).toISOString(), moneda: b.moneda })
      .eq("id", req.params.id)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new HttpError(404, "Evento no encontrado.");
    return salida(data);
  });

  app.post<{ Params: { id: string } }>("/eventos/:id/archivar", admin, async (req) => {
    await exigirEvento(req.usuario, req.params.id);
    const { archivado } = z.object({ archivado: z.boolean() }).parse(req.body);
    const { error } = await db().from("eventos").update({ archivado }).eq("id", req.params.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

  // Imagen del evento o QR de pago. ?tipo=imagen | qr-pago
  app.post<{ Params: { id: string }; Querystring: { tipo?: string } }>("/eventos/:id/imagen", admin, async (req) => {
    await exigirEvento(req.usuario, req.params.id);
    const tipo = req.query.tipo === "qr-pago" ? "qr-pago" : "imagen";
    const { archivo } = await leerFormulario(req, "archivo");
    if (!archivo) throw new HttpError(400, "Adjuntá una imagen.");
    const t = detectarTipo(archivo);
    if (!t || t.ext === "pdf") throw new HttpError(415, "Debe ser una imagen JPG, PNG o WEBP.");
    const path = `${req.params.id}/${tipo}-${randomBytes(4).toString("hex")}.${t.ext}`;
    const up = await db().storage.from(BUCKET_PUBLICO).upload(path, archivo, { contentType: t.mime });
    if (up.error) throw new Error(up.error.message);
    const col = tipo === "qr-pago" ? "qr_pago_path" : "imagen_path";
    const { data: antes } = await db().from("eventos").select(col).eq("id", req.params.id).maybeSingle();
    const { error } = await db().from("eventos").update({ [col]: path }).eq("id", req.params.id);
    if (error) throw new Error(error.message);
    const vieja = (antes as Record<string, string | null> | null)?.[col];
    if (vieja) await db().storage.from(BUCKET_PUBLICO).remove([vieja]);
    return { url: urlPublica(path) };
  });

  app.post<{ Params: { id: string } }>("/eventos/:id/tipos", admin, async (req, reply) => {
    await exigirEvento(req.usuario, req.params.id);
    const b = tipoSchema.parse(req.body);
    const { data, error } = await db()
      .from("tipos_ticket")
      .insert({ evento_id: req.params.id, nombre: b.nombre, precio: b.precio, cupo: b.cupo ?? null, categoria: b.categoria, activo: b.activo })
      .select("*")
      .single();
    if (error) throw new HttpError(error.code === "23505" ? 409 : 500, error.code === "23505" ? "Ya existe un tipo con ese nombre." : error.message);
    reply.code(201);
    return { id: data.id };
  });

  app.put<{ Params: { id: string } }>("/tipos/:id", admin, async (req) => {
    await exigirTipo(req.usuario, req.params.id);
    const b = tipoSchema.parse(req.body);
    // categoría fija una vez creado (cambiarla alteraría el significado de tickets ya emitidos)
    const { data, error } = await db()
      .from("tipos_ticket")
      .update({ nombre: b.nombre, precio: b.precio, cupo: b.cupo ?? null, activo: b.activo })
      .eq("id", req.params.id)
      .select("id")
      .maybeSingle();
    if (error) throw new HttpError(error.code === "23505" ? 409 : 500, error.code === "23505" ? "Ya existe un tipo con ese nombre." : error.message);
    if (!data) throw new HttpError(404, "Tipo no encontrado.");
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>("/eventos/:id/equipo", admin, async (req) => {
    await exigirEvento(req.usuario, req.params.id);
    const { usuarioIds } = z.object({ usuarioIds: z.array(z.string().uuid()).max(200) }).parse(req.body);
    // Solo se puede asignar gente de la MISMA organización del evento
    const { data: evOrg } = await db().from("eventos").select("org_id").eq("id", req.params.id).single();
    if (usuarioIds.length) {
      const { data: validos } = await db().from("usuarios").select("id").in("id", usuarioIds).eq("org_id", evOrg!.org_id).neq("rol", "superadmin");
      if ((validos?.length ?? 0) !== new Set(usuarioIds).size) throw new HttpError(400, "Algún usuario no pertenece a la organización del evento.");
    }
    await db().from("evento_equipo").delete().eq("evento_id", req.params.id);
    if (usuarioIds.length) {
      const { error } = await db().from("evento_equipo").insert(usuarioIds.map((u) => ({ evento_id: req.params.id, usuario_id: u })));
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/eventos/:id/resumen", miembro, async (req) => {
    const id = req.params.id;
    await exigirEvento(req.usuario, id);
    // Una sola consulta a la base (función SQL resumen_evento) en vez de ~15 viajes seguidos.
    const { data, error } = await db().rpc("resumen_evento", { p_evento: id });
    if (error) throw new Error(error.message);
    return data;
  });
}
