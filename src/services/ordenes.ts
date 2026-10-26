import { randomUUID } from "node:crypto";
import { frontendUrl } from "../lib/config";
import { BUCKET_COMPROBANTES, db, urlPublica } from "../lib/db";
import { errorDeFuncionSql, HttpError } from "../lib/errores";
import { enviarEntradas, enviarRechazo, type DatosEvento } from "../lib/mailer";
import { sha256Hex } from "../lib/seguridad";
import { generarToken, qrPng } from "../lib/tickets";
import { ocultarCorreo, type DatosOrden, type TipoArchivo } from "../lib/validar";

export async function crearOrden(
  slug: string,
  tipoTicketId: string,
  datos: DatosOrden,
  archivo: Uint8Array,
  tipoArchivo: TipoArchivo,
  ref: string | null = null,
): Promise<{ numero: number; acceso: string | null }> {
  const path = `${slug}/${randomUUID()}.${tipoArchivo.ext}`;
  const sub = await db().storage.from(BUCKET_COMPROBANTES).upload(path, archivo, { contentType: tipoArchivo.mime, upsert: false });
  if (sub.error) throw new Error(`No se pudo guardar el comprobante: ${sub.error.message}`);

  // crear_orden valida evento, tipo y cupo y escribe la orden en UNA transacción con la fila del tipo bloqueada:
  // así muchas compras simultáneas no pueden pasarse del cupo.
  const { data, error } = await db().rpc("crear_orden", {
    p_slug: slug, p_tipo: tipoTicketId, p_nombre: datos.nombre, p_telefono: datos.telefono, p_email: datos.email,
    p_cantidad: datos.cantidad, p_path: path, p_sha: sha256Hex(archivo),
  });
  if (error) {
    await db().storage.from(BUCKET_COMPROBANTES).remove([path]);
    if (error.code === "23505") {
      if (error.message.includes("comprobante")) throw new HttpError(409, "Ese comprobante ya fue enviado en otra orden.");
      throw new HttpError(409, "Ya hay una orden activa con ese correo para este evento.");
    }
    throw errorDeFuncionSql(error.message) ?? new Error(error.message);
  }
  const numero = Number(data);
  // El promotor solo sirve para contar ventas: si esto fallara, la orden ya está creada y la compra sigue siendo válida
  const fila = ref
    ? await db().from("ordenes").update({ ref }).eq("numero", numero).select("acceso").maybeSingle()
    : await db().from("ordenes").select("acceso").eq("numero", numero).maybeSingle();
  return { numero, acceso: (fila.data?.acceso as string | undefined) ?? null };
}

const linkOrden = (acceso: string) => `${frontendUrl()}/o/${acceso}`;
const uno = <T>(r: T | T[] | null): T | null => (Array.isArray(r) ? r[0] ?? null : r);

/** Lo que ve el comprador en el link de su orden. Sin teléfono ni comprobante, y el correo a medias: el link se puede compartir. */
export async function ordenPublica(acceso: string) {
  const { data: o } = await db()
    .from("ordenes")
    .select("id, numero, nombre, email, cantidad, monto, estado, motivo_rechazo, creada_en, tipos_ticket(nombre), eventos(slug, nombre, fecha_inicio, lugar, direccion_url, moneda, imagen_path, whatsapp, edad_minima)")
    .eq("acceso", acceso)
    .maybeSingle();
  if (!o) throw new HttpError(404, "Orden no encontrada.");
  const ev = uno(o.eventos as unknown as Record<string, any> | Record<string, any>[] | null)!;
  let entradas: { tipo: string; estado: string; qr: string | null }[] = [];
  if (o.estado === "Aprobada") {
    const { data } = await db().from("entradas").select("token, estado, tipos_ticket(nombre)").eq("orden_id", o.id).order("creada_en");
    entradas = await Promise.all(
      (data ?? []).map(async (e) => ({
        tipo: uno(e.tipos_ticket as unknown as { nombre: string } | { nombre: string }[] | null)?.nombre ?? "",
        estado: e.estado as string,
        // Una entrada anulada no muestra su QR
        qr: e.estado === "anulada" ? null : `data:image/png;base64,${(await qrPng(e.token as string)).toString("base64")}`,
      })),
    );
  }
  return {
    numero: o.numero, nombre: o.nombre, correo: ocultarCorreo(o.email), cantidad: o.cantidad, monto: Number(o.monto),
    estado: o.estado, motivoRechazo: o.motivo_rechazo, creadaEn: o.creada_en,
    tipo: uno(o.tipos_ticket as unknown as { nombre: string } | { nombre: string }[] | null)?.nombre ?? "",
    evento: {
      slug: ev.slug, nombre: ev.nombre, fechaInicio: ev.fecha_inicio, lugar: ev.lugar, direccionUrl: ev.direccion_url,
      moneda: ev.moneda, imagenUrl: urlPublica(ev.imagen_path), whatsapp: ev.whatsapp, edadMinima: ev.edad_minima,
    },
    entradas,
  };
}

type OrdenFila = { id: string; evento_id: string; tipo_ticket_id: string; nombre: string; email: string; cantidad: number };

async function cargarEvento(id: string): Promise<DatosEvento> {
  const { data, error } = await db().from("eventos").select("nombre, fecha_inicio, lugar, direccion_url").eq("id", id).single();
  if (error) throw new Error(error.message);
  return data as DatosEvento;
}

async function correoEntradas(orden: OrdenFila): Promise<void> {
  const { data, error } = await db()
    .from("entradas")
    .select("token, tipos_ticket(nombre)")
    .eq("orden_id", orden.id)
    .eq("estado", "valida")
    .order("creada_en");
  if (error || !data?.length) throw new HttpError(409, "La orden no tiene entradas vigentes para enviar.");
  const tokens = data.map((e) => {
    const t = e.tipos_ticket as unknown as { nombre: string } | { nombre: string }[] | null;
    return { token: e.token as string, tipo: (Array.isArray(t) ? t[0]?.nombre : t?.nombre) ?? "" };
  });
  const { data: a } = await db().from("ordenes").select("acceso").eq("id", orden.id).maybeSingle();
  try {
    await enviarEntradas(orden.email, orden.nombre, await cargarEvento(orden.evento_id), tokens, a?.acceso ? linkOrden(a.acceso) : undefined);
    await db().from("ordenes").update({ correo_enviado_en: new Date().toISOString(), correo_error: null }).eq("id", orden.id);
  } catch (e) {
    await db().from("ordenes").update({ correo_error: (e instanceof Error ? e.message : String(e)).slice(0, 500) }).eq("id", orden.id);
    throw e;
  }
}

/** aprobar_orden valida el cupo, cambia el estado y crea las entradas en UNA transacción.
 *  Idempotente: un segundo clic (o dos admins a la vez) recibe 409 y no duplica entradas. */
export async function aprobarOrden(id: string, usuarioId: string, orgId: string | null): Promise<{ correoEnCamino: true }> {
  const { data: previa } = await db().from("ordenes").select("cantidad").eq("id", id).maybeSingle();
  if (!previa) throw new HttpError(404, "La orden no existe.");
  const { data, error } = await db().rpc("aprobar_orden", {
    p_id: id, p_user: usuarioId, p_tokens: Array.from({ length: previa.cantidad }, () => generarToken()),
    p_org: orgId, // la base también se niega a aprobar una orden de otra organización
  });
  if (error) throw errorDeFuncionSql(error.message) ?? new Error(error.message);
  const orden = (data as OrdenFila[])[0];
  // El correo (SMTP + generar los QR) tarda unos segundos: se envía en segundo plano y la respuesta es inmediata.
  // Si falla, el error queda guardado en la orden (correo_error) y el panel ofrece «Reenviar correo».
  void correoEntradas(orden).catch(() => {});
  return { correoEnCamino: true };
}

export async function rechazarOrden(id: string, motivo: string, usuarioId: string): Promise<{ correoEnCamino: true }> {
  const { data, error } = await db()
    .from("ordenes")
    .update({ estado: "Rechazada", motivo_rechazo: motivo, resuelta_en: new Date().toISOString(), resuelta_por: usuarioId })
    .eq("id", id)
    .eq("estado", "Pendiente")
    .select("evento_id, email, nombre")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new HttpError(409, "La orden ya fue resuelta o no existe.");
  // En segundo plano (ver aprobarOrden): la respuesta no espera al SMTP.
  void (async () => {
    try {
      await enviarRechazo(data.email, data.nombre, await cargarEvento(data.evento_id), motivo);
      await db().from("ordenes").update({ correo_enviado_en: new Date().toISOString(), correo_error: null }).eq("id", id);
    } catch (e) {
      await db().from("ordenes").update({ correo_error: (e instanceof Error ? e.message : String(e)).slice(0, 500) }).eq("id", id);
    }
  })().catch(() => {});
  return { correoEnCamino: true };
}

export async function reenviarOrden(id: string): Promise<void> {
  const { data } = await db().from("ordenes").select("id, evento_id, tipo_ticket_id, nombre, email, cantidad, estado, motivo_rechazo").eq("id", id).maybeSingle();
  if (!data) throw new HttpError(404, "La orden no existe.");
  if (data.estado === "Aprobada") return correoEntradas(data as OrdenFila);
  if (data.estado === "Rechazada")
    return enviarRechazo(data.email, data.nombre, await cargarEvento(data.evento_id), data.motivo_rechazo ?? "");
  throw new HttpError(409, "La orden sigue pendiente: no hay nada que reenviar.");
}
