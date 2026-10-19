import { randomUUID } from "node:crypto";
import { BUCKET_COMPROBANTES, db } from "../lib/db";
import { errorDeFuncionSql, HttpError } from "../lib/errores";
import { enviarEntradas, enviarRechazo, type DatosEvento } from "../lib/mailer";
import { sha256Hex } from "../lib/seguridad";
import { generarToken } from "../lib/tickets";
import type { DatosOrden, TipoArchivo } from "../lib/validar";

export async function crearOrden(
  slug: string,
  tipoTicketId: string,
  datos: DatosOrden,
  archivo: Uint8Array,
  tipoArchivo: TipoArchivo,
): Promise<{ numero: number }> {
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
  return { numero: Number(data) };
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
  try {
    await enviarEntradas(orden.email, orden.nombre, await cargarEvento(orden.evento_id), tokens);
    await db().from("ordenes").update({ correo_enviado_en: new Date().toISOString(), correo_error: null }).eq("id", orden.id);
  } catch (e) {
    await db().from("ordenes").update({ correo_error: (e instanceof Error ? e.message : String(e)).slice(0, 500) }).eq("id", orden.id);
    throw e;
  }
}

/** aprobar_orden valida el cupo, cambia el estado y crea las entradas en UNA transacción.
 *  Idempotente: un segundo clic (o dos admins a la vez) recibe 409 y no duplica entradas. */
export async function aprobarOrden(id: string, usuarioId: string): Promise<{ correoOk: boolean; error?: string }> {
  const { data: previa } = await db().from("ordenes").select("cantidad").eq("id", id).maybeSingle();
  if (!previa) throw new HttpError(404, "La orden no existe.");
  const { data, error } = await db().rpc("aprobar_orden", {
    p_id: id, p_user: usuarioId, p_tokens: Array.from({ length: previa.cantidad }, () => generarToken()),
  });
  if (error) throw errorDeFuncionSql(error.message) ?? new Error(error.message);
  const orden = (data as OrdenFila[])[0];
  try {
    await correoEntradas(orden);
    return { correoOk: true };
  } catch (e) {
    return { correoOk: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function rechazarOrden(id: string, motivo: string, usuarioId: string): Promise<{ correoOk: boolean; error?: string }> {
  const { data, error } = await db()
    .from("ordenes")
    .update({ estado: "Rechazada", motivo_rechazo: motivo, resuelta_en: new Date().toISOString(), resuelta_por: usuarioId })
    .eq("id", id)
    .eq("estado", "Pendiente")
    .select("evento_id, email, nombre")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new HttpError(409, "La orden ya fue resuelta o no existe.");
  try {
    await enviarRechazo(data.email, data.nombre, await cargarEvento(data.evento_id), motivo);
    await db().from("ordenes").update({ correo_enviado_en: new Date().toISOString() }).eq("id", id);
    return { correoOk: true };
  } catch (e) {
    return { correoOk: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function reenviarOrden(id: string): Promise<void> {
  const { data } = await db().from("ordenes").select("id, evento_id, tipo_ticket_id, nombre, email, cantidad, estado, motivo_rechazo").eq("id", id).maybeSingle();
  if (!data) throw new HttpError(404, "La orden no existe.");
  if (data.estado === "Aprobada") return correoEntradas(data as OrdenFila);
  if (data.estado === "Rechazada")
    return enviarRechazo(data.email, data.nombre, await cargarEvento(data.evento_id), data.motivo_rechazo ?? "");
  throw new HttpError(409, "La orden sigue pendiente: no hay nada que reenviar.");
}
