import { randomUUID } from "node:crypto";
import { BUCKET_COMPROBANTES, db } from "../lib/db";
import { HttpError } from "../lib/errores";
import { enviarEntradas, enviarRechazo, type DatosEvento } from "../lib/mailer";
import { sha256Hex } from "../lib/seguridad";
import { generarToken } from "../lib/tickets";
import type { DatosOrden, TipoArchivo } from "../lib/validar";
import { exigirCupo } from "./cupos";

type TipoRow = { id: string; evento_id: string; precio: string | number; cupo: number | null; categoria: string; activo: boolean };

export async function crearOrden(
  slug: string,
  tipoTicketId: string,
  datos: DatosOrden,
  archivo: Uint8Array,
  tipoArchivo: TipoArchivo,
): Promise<{ numero: number }> {
  const { data: ev } = await db().from("eventos").select("id, archivado, fecha_inicio").eq("slug", slug).maybeSingle();
  if (!ev || ev.archivado) throw new HttpError(404, "Evento no encontrado.");
  const { data: tipo } = await db()
    .from("tipos_ticket")
    .select("id, evento_id, precio, cupo, categoria, activo")
    .eq("id", tipoTicketId)
    .maybeSingle<TipoRow>();
  if (!tipo || tipo.evento_id !== ev.id || !tipo.activo || tipo.categoria !== "venta")
    throw new HttpError(400, "Elegí un tipo de ticket válido.");
  await exigirCupo(tipo.id, tipo.cupo, datos.cantidad);

  const path = `${ev.id}/${randomUUID()}.${tipoArchivo.ext}`;
  const sub = await db().storage.from(BUCKET_COMPROBANTES).upload(path, archivo, { contentType: tipoArchivo.mime, upsert: false });
  if (sub.error) throw new Error(`No se pudo guardar el comprobante: ${sub.error.message}`);

  const { data, error } = await db()
    .from("ordenes")
    .insert({
      ...datos,
      evento_id: ev.id,
      tipo_ticket_id: tipo.id,
      monto: Number(tipo.precio) * datos.cantidad,
      comprobante_path: path,
      comprobante_sha256: sha256Hex(archivo),
    })
    .select("numero")
    .single();
  if (error) {
    await db().storage.from(BUCKET_COMPROBANTES).remove([path]);
    if (error.code === "23505") {
      if (error.message.includes("comprobante")) throw new HttpError(409, "Ese comprobante ya fue enviado en otra orden.");
      throw new HttpError(409, "Ya hay una orden activa con ese correo para este evento.");
    }
    throw new Error(error.message);
  }
  return { numero: data.numero };
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

/** Pendiente→Aprobada es un UPDATE condicional: aprobar dos veces la misma orden no duplica entradas. */
export async function aprobarOrden(id: string, usuarioId: string): Promise<{ correoOk: boolean; error?: string }> {
  const { data: previa } = await db().from("ordenes").select("tipo_ticket_id, cantidad, estado").eq("id", id).maybeSingle();
  if (!previa) throw new HttpError(404, "La orden no existe.");
  if (previa.estado !== "Pendiente") throw new HttpError(409, "La orden ya fue resuelta.");
  const { data: tipo } = await db().from("tipos_ticket").select("cupo").eq("id", previa.tipo_ticket_id).single();
  // Esta orden ya cuenta como reservada mientras está pendiente.
  await exigirCupo(previa.tipo_ticket_id, tipo?.cupo ?? null, previa.cantidad, previa.cantidad);

  const { data, error } = await db()
    .from("ordenes")
    .update({ estado: "Aprobada", resuelta_en: new Date().toISOString(), resuelta_por: usuarioId })
    .eq("id", id)
    .eq("estado", "Pendiente")
    .select("id, evento_id, tipo_ticket_id, nombre, email, cantidad")
    .maybeSingle<OrdenFila>();
  if (error) throw new Error(error.message);
  if (!data) throw new HttpError(409, "La orden ya fue resuelta.");

  const filas = Array.from({ length: data.cantidad }, () => ({
    evento_id: data.evento_id, tipo_ticket_id: data.tipo_ticket_id, orden_id: id,
    nombre: data.nombre, email: data.email, token: generarToken(), creada_por: usuarioId,
  }));
  const ins = await db().from("entradas").insert(filas);
  if (ins.error) {
    await db().from("ordenes").update({ estado: "Pendiente", resuelta_en: null, resuelta_por: null }).eq("id", id);
    throw new Error(ins.error.message);
  }
  try {
    await correoEntradas(data);
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
