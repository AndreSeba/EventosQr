import type { FastifyInstance } from "fastify";
import { numero } from "../lib/config";
import { db, urlPublica } from "../lib/db";
import { HttpError } from "../lib/errores";
import { leerFormulario } from "../lib/multipart";
import { verificarCorreoReal } from "../lib/contacto";
import { detectarTipo, validarDatosOrden } from "../lib/validar";
import { disponibles } from "../services/cupos";
import { crearOrden } from "../services/ordenes";

export async function publicoRoutes(app: FastifyInstance) {
  app.get<{ Params: { slug: string } }>("/public/eventos/:slug", async (req) => {
    const { data: ev } = await db()
      .from("eventos")
      .select("id, slug, nombre, descripcion, lugar, direccion_url, fecha_inicio, moneda, imagen_path, qr_pago_path, archivado")
      .eq("slug", req.params.slug)
      .maybeSingle();
    if (!ev || ev.archivado) throw new HttpError(404, "Evento no encontrado.");
    const { data: tipos } = await db()
      .from("tipos_ticket")
      .select("id, nombre, precio, precio_regular, cupo")
      .eq("evento_id", ev.id)
      .eq("categoria", "venta")
      .eq("activo", true)
      .order("precio");
    return {
      slug: ev.slug,
      nombre: ev.nombre,
      descripcion: ev.descripcion,
      lugar: ev.lugar,
      direccionUrl: ev.direccion_url,
      fechaInicio: ev.fecha_inicio,
      moneda: ev.moneda,
      imagenUrl: urlPublica(ev.imagen_path),
      qrPagoUrl: urlPublica(ev.qr_pago_path),
      maxPorOrden: numero("MAX_ENTRADAS_POR_ORDEN", 5),
      maxComprobanteMb: numero("MAX_COMPROBANTE_MB", 2),
      tipos: await Promise.all(
        (tipos ?? []).map(async (t) => ({
          id: t.id, nombre: t.nombre, precio: Number(t.precio), precioRegular: t.precio_regular !== null && Number(t.precio_regular) > Number(t.precio) ? Number(t.precio_regular) : null, disponibles: await disponibles(t.id, t.cupo),
        })),
      ),
    };
  });

  app.post<{ Params: { slug: string } }>(
    "/public/eventos/:slug/ordenes",
    { config: { rateLimit: { max: 6, timeWindow: "10 minutes" } } },
    async (req) => {
      const { campos, archivo } = await leerFormulario(req, "comprobante");
      if (campos.web) return { ok: true, numero: 0 }; // honeypot: fingimos éxito
      const v = validarDatosOrden(campos, numero("MAX_ENTRADAS_POR_ORDEN", 5));
      if (!v.ok) throw new HttpError(400, v.error);
      const correo = await verificarCorreoReal(v.datos.email); // dominio existente, no desechable, sin errores de tipeo típicos
      if (!correo.ok) throw new HttpError(400, correo.error);
      if (!campos.tipoTicketId) throw new HttpError(400, "Elegí un tipo de ticket.");
      if (!archivo) throw new HttpError(400, "Adjuntá el comprobante de pago.");
      if (archivo.length > numero("MAX_COMPROBANTE_MB", 2) * 1024 * 1024) throw new HttpError(413, "El comprobante es demasiado grande.");
      const tipo = detectarTipo(archivo);
      if (!tipo) throw new HttpError(415, "El comprobante debe ser JPG, PNG, WEBP o PDF.");
      return { ok: true, ...(await crearOrden(req.params.slug, campos.tipoTicketId, v.datos, archivo, tipo)) };
    },
  );
}
