import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { exigir } from "../auth";
import { BUCKET_COMPROBANTES, db } from "../lib/db";
import { HttpError } from "../lib/errores";
import { aprobarOrden, rechazarOrden, reenviarOrden } from "../services/ordenes";

export async function ordenesRoutes(app: FastifyInstance) {
  const admin = { preHandler: exigir("admin") };

  app.get<{ Querystring: { eventoId?: string; estado?: string } }>("/ordenes", admin, async (req) => {
    let q = db()
      .from("ordenes")
      .select("*, tipos_ticket(nombre)")
      .order("creada_en", { ascending: false })
      .limit(500);
    if (req.query.eventoId) q = q.eq("evento_id", req.query.eventoId);
    if (["Pendiente", "Aprobada", "Rechazada"].includes(req.query.estado ?? "")) q = q.eq("estado", req.query.estado!);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data.map((o) => {
      const t = o.tipos_ticket as { nombre: string } | { nombre: string }[] | null;
      return {
        id: o.id, numero: o.numero, eventoId: o.evento_id, tipo: (Array.isArray(t) ? t[0]?.nombre : t?.nombre) ?? "",
        nombre: o.nombre, telefono: o.telefono, email: o.email, cantidad: o.cantidad, monto: Number(o.monto),
        estado: o.estado, motivoRechazo: o.motivo_rechazo, creadaEn: o.creada_en,
        correoEnviadoEn: o.correo_enviado_en, correoError: o.correo_error,
      };
    });
  });

  app.get<{ Params: { id: string } }>("/ordenes/:id/comprobante", admin, async (req) => {
    const { data } = await db().from("ordenes").select("comprobante_path").eq("id", req.params.id).maybeSingle();
    if (!data) throw new HttpError(404, "Orden no encontrada.");
    const { data: firmada, error } = await db().storage.from(BUCKET_COMPROBANTES).createSignedUrl(data.comprobante_path, 120);
    if (error || !firmada) throw new Error("No se pudo abrir el comprobante.");
    return { url: firmada.signedUrl };
  });

  app.post<{ Params: { id: string } }>("/ordenes/:id/aprobar", admin, async (req) => aprobarOrden(req.params.id, req.usuario.id));

  app.post<{ Params: { id: string } }>("/ordenes/:id/rechazar", admin, async (req) => {
    const { motivo } = z.object({ motivo: z.string().trim().min(3, "Indicá un motivo.").max(300) }).parse(req.body);
    return rechazarOrden(req.params.id, motivo, req.usuario.id);
  });

  app.post<{ Params: { id: string } }>("/ordenes/:id/reenviar", admin, async (req) => {
    await reenviarOrden(req.params.id);
    return { ok: true };
  });
}
