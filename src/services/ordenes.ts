import { randomUUID } from "node:crypto";
import { frontendUrl } from "../lib/config";
import { BUCKET_COMPROBANTES, db, urlPublica } from "../lib/db";
import { errorDeFuncionSql, HttpError } from "../lib/errores";
import { enviarEntradas, enviarRechazo, type DatosEvento } from "../lib/mailer";
import { sha256Hex } from "../lib/seguridad";
import { generarToken, qrPng } from "../lib/tickets";
import { limpiarCi, limpiarNombre, ocultarCi, type Titular } from "../lib/titulares";
import { ocultarCorreo, type DatosOrden, type TipoArchivo } from "../lib/validar";

export async function crearOrden(
  slug: string,
  tipoTicketId: string,
  datos: DatosOrden,
  archivo: Uint8Array,
  tipoArchivo: TipoArchivo,
  ref: string | null = null,
  titulares: Titular[] | null = null,
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
  // El promotor y los datos de los titulares son opcionales: si esto fallara, la orden ya está creada y la compra sigue siendo válida
  const extra: Record<string, unknown> = {};
  if (ref) extra.ref = ref;
  if (titulares) extra.titulares = titulares;
  const fila = Object.keys(extra).length
    ? await db().from("ordenes").update(extra).eq("numero", numero).select("acceso").maybeSingle()
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
  type EntradaPublica = {
    n: number; tipo: string; estado: string; qr: string | null; nombre: string; titularDefinido: boolean; ciParcial: string | null;
    transferencias: number; editable: boolean;
  };
  let entradas: EntradaPublica[] = [];
  if (o.estado === "Aprobada") {
    const { data } = await db()
      .from("entradas")
      .select("token, estado, nombre, ci, numero_en_orden, titular_definido, transferencias, tipos_ticket(nombre)")
      .eq("orden_id", o.id)
      .order("numero_en_orden");
    // Los datos y la transferencia se pueden cambiar hasta que empieza el evento, mientras la entrada siga vigente
    const antesDelEvento = new Date(ev.fecha_inicio).getTime() > Date.now();
    entradas = await Promise.all(
      (data ?? []).map(async (e) => ({
        n: e.numero_en_orden as number,
        tipo: uno(e.tipos_ticket as unknown as { nombre: string } | { nombre: string }[] | null)?.nombre ?? "",
        estado: e.estado as string,
        // Una entrada anulada no muestra su QR
        qr: e.estado === "anulada" ? null : `data:image/png;base64,${(await qrPng(e.token as string)).toString("base64")}`,
        nombre: e.nombre as string,
        titularDefinido: e.titular_definido as boolean,
        ciParcial: ocultarCi(e.ci as string | null),
        transferencias: e.transferencias as number,
        editable: e.estado === "valida" && antesDelEvento,
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

// ---------- Titular de cada entrada ----------
const MAX_TRANSFERENCIAS = 3;
type DatosEntrada = { nombre: string; ci: string | null };

/** Deja constancia de quién cambió el titular de una entrada y qué había antes. Si el registro falla, el cambio ya hecho no se deshace. */
export async function registrarCambioEntrada(entradaId: string, tipo: "titular" | "transferencia", por: string, antes: DatosEntrada, despues: DatosEntrada): Promise<void> {
  const { error } = await db().from("entrada_cambios").insert({
    entrada_id: entradaId, tipo, por, nombre_anterior: antes.nombre, ci_anterior: antes.ci, nombre_nuevo: despues.nombre, ci_nuevo: despues.ci,
  });
  if (error) console.error("No se pudo registrar el cambio de titular:", error.message);
}

async function entradaDeOrden(acceso: string, n: number) {
  if (!/^[a-f0-9]{64}$/.test(acceso) || !Number.isInteger(n) || n < 1 || n > 50) throw new HttpError(404, "Orden no encontrada.");
  const { data: o } = await db().from("ordenes").select("id, estado, eventos(fecha_inicio)").eq("acceso", acceso).maybeSingle();
  if (!o) throw new HttpError(404, "Orden no encontrada.");
  if (o.estado !== "Aprobada") throw new HttpError(409, "La orden todavía no está aprobada.");
  const ev = uno(o.eventos as unknown as { fecha_inicio: string } | { fecha_inicio: string }[] | null);
  if (!ev || new Date(ev.fecha_inicio).getTime() <= Date.now())
    throw new HttpError(409, "El evento ya empezó: desde acá los datos ya no se pueden cambiar. Pedíselo al organizador.");
  const { data: e } = await db().from("entradas").select("id, estado, nombre, ci, transferencias").eq("orden_id", o.id).eq("numero_en_orden", n).maybeSingle();
  if (!e) throw new HttpError(404, "Entrada no encontrada.");
  if (e.estado !== "valida") throw new HttpError(409, "Solo se pueden cambiar entradas vigentes (no usadas ni anuladas).");
  return e as { id: string; estado: string; nombre: string; ci: string | null; transferencias: number };
}

/** El comprador corrige el nombre o la cédula del titular de una de sus entradas (el QR sigue siendo el mismo). */
export async function cambiarTitularComprador(acceso: string, n: number, body: { nombre?: unknown; ci?: unknown }): Promise<void> {
  const nom = limpiarNombre(body.nombre);
  if (!nom.ok) throw new HttpError(400, "El nombre debe tener entre 2 y 100 letras.");
  const ci = body.ci === undefined ? undefined : limpiarCi(body.ci);
  if (ci && !ci.ok) throw new HttpError(400, "La cédula no es válida (4 a 20 letras o números).");
  const cambios: Record<string, unknown> = {};
  if (nom.nombre) { cambios.nombre = nom.nombre; cambios.titular_definido = true; }
  if (ci && ci.ok) cambios.ci = ci.ci;
  if (!Object.keys(cambios).length) throw new HttpError(400, "No hay nada para cambiar.");
  const e = await entradaDeOrden(acceso, n);
  const { data, error } = await db().from("entradas").update(cambios).eq("id", e.id).eq("estado", "valida").select("id").maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new HttpError(409, "Esta entrada ya no está vigente.");
  await registrarCambioEntrada(e.id, "titular", "comprador", e, { nombre: (cambios.nombre as string) ?? e.nombre, ci: "ci" in cambios ? (cambios.ci as string | null) : e.ci });
}

/** Transferir: la entrada pasa a otra persona con un QR NUEVO y el anterior deja de servir, así una captura vieja ya no sirve para entrar. */
export async function transferirEntrada(acceso: string, n: number, body: { nombre?: unknown; ci?: unknown }): Promise<void> {
  const nom = limpiarNombre(body.nombre);
  if (!nom.ok || !nom.nombre) throw new HttpError(400, "Ingresá el nombre de quien recibe la entrada (2 a 100 letras).");
  const ci = limpiarCi(body.ci);
  if (!ci.ok) throw new HttpError(400, "La cédula no es válida (4 a 20 letras o números).");
  const e = await entradaDeOrden(acceso, n);
  if (e.transferencias >= MAX_TRANSFERENCIAS) throw new HttpError(409, `Esta entrada ya se transfirió ${MAX_TRANSFERENCIAS} veces. Para otro cambio, escribile al organizador.`);
  const { data, error } = await db()
    .from("entradas")
    .update({ token: generarToken(), nombre: nom.nombre, ci: ci.ci, titular_definido: true, transferencias: e.transferencias + 1 })
    .eq("id", e.id)
    .eq("estado", "valida")
    .eq("transferencias", e.transferencias) // si dos transferencias llegan juntas, solo una gana
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new HttpError(409, "La entrada cambió mientras tanto. Volvé a intentarlo.");
  await registrarCambioEntrada(e.id, "transferencia", "comprador", e, { nombre: nom.nombre, ci: ci.ci });
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
