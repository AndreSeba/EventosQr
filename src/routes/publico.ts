import type { FastifyInstance } from "fastify";
import { numero } from "../lib/config";
import { db, urlPublica } from "../lib/db";
import { HttpError } from "../lib/errores";
import { leerFormulario } from "../lib/multipart";
import { verificarCorreoReal } from "../lib/contacto";
import { detectarTipo, limpiarRef, validarDatosOrden } from "../lib/validar";
import { disponibles } from "../services/cupos";
import { validarTitulares } from "../lib/titulares";
import { cambiarTitularComprador, crearOrden, ordenPublica, transferirEntrada } from "../services/ordenes";

const orgActiva = (o: unknown) => !!(Array.isArray(o) ? o[0] : (o as { activa?: boolean } | null))?.activa;

export async function publicoRoutes(app: FastifyInstance) {
  app.get<{ Params: { slug: string } }>("/public/eventos/:slug", async (req) => {
    const { data: ev } = await db()
      .from("eventos")
      .select("id, slug, nombre, descripcion, lugar, direccion_url, fecha_inicio, moneda, imagen_path, qr_pago_path, edad_minima, whatsapp, archivado, organizaciones(activa)")
      .eq("slug", req.params.slug)
      .maybeSingle();
    if (!ev || ev.archivado || !orgActiva(ev.organizaciones)) throw new HttpError(404, "Evento no encontrado.");
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
      edadMinima: ev.edad_minima,
      whatsapp: ev.whatsapp,
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
      // Si la organización fue desactivada, sus ventas se cierran
      const { data: ev } = await db().from("eventos").select("archivado, organizaciones(activa)").eq("slug", req.params.slug).maybeSingle();
      if (!ev || ev.archivado || !orgActiva(ev.organizaciones)) throw new HttpError(404, "Evento no encontrado.");
      if (!campos.tipoTicketId) throw new HttpError(400, "Elegí un tipo de ticket.");
      if (!archivo) throw new HttpError(400, "Adjuntá el comprobante de pago.");
      if (archivo.length > numero("MAX_COMPROBANTE_MB", 2) * 1024 * 1024) throw new HttpError(413, "El comprobante es demasiado grande.");
      const tipo = detectarTipo(archivo);
      if (!tipo) throw new HttpError(415, "El comprobante debe ser JPG, PNG, WEBP o PDF.");
      // Cédula y nombres de los acompañantes: opcionales. Si vienen mal escritos se avisa ANTES de guardar el comprobante.
      const tit = validarTitulares(campos.titulares, v.datos.cantidad);
      if (!tit.ok) throw new HttpError(400, tit.error);
      return { ok: true, ...(await crearOrden(req.params.slug, campos.tipoTicketId, v.datos, archivo, tipo, limpiarRef(campos.ref), tit.titulares)) };
    },
  );

  // El comprador corrige el titular de una de sus entradas, o la transfiere (QR nuevo, el anterior deja de servir).
  // Las dos exigen el token secreto de la orden y que el evento no haya empezado.
  const limite = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
  app.put<{ Params: { acceso: string; n: string }; Body: { nombre?: unknown; ci?: unknown } }>("/public/ordenes/:acceso/entradas/:n", limite, async (req) => {
    await cambiarTitularComprador(req.params.acceso, Number(req.params.n), req.body ?? {});
    return { ok: true };
  });
  app.post<{ Params: { acceso: string; n: string }; Body: { nombre?: unknown; ci?: unknown } }>("/public/ordenes/:acceso/entradas/:n/transferir", limite, async (req) => {
    await transferirEntrada(req.params.acceso, Number(req.params.n), req.body ?? {});
    return { ok: true };
  });

  // Link de la orden: quien tiene el token (64 caracteres al azar) ve el estado y, si se aprobó, sus QR.
  app.get<{ Params: { acceso: string } }>(
    "/public/ordenes/:acceso",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req) => {
      if (!/^[a-f0-9]{64}$/.test(req.params.acceso)) throw new HttpError(404, "Orden no encontrada.");
      return ordenPublica(req.params.acceso);
    },
  );
}
