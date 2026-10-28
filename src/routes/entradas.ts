import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { exigir, exigirEntrada, exigirEvento } from "../auth";
import { db, todas } from "../lib/db";
import { errorDeFuncionSql, HttpError } from "../lib/errores";
import { enviarEntradas, type DatosEvento } from "../lib/mailer";
import { generarToken } from "../lib/tickets";
import { limpiarCi, limpiarNombre } from "../lib/titulares";
import { emailValido } from "../lib/validar";
import { registrarCambioEntrada } from "../services/ordenes";

type Rel<T> = T | T[] | null;
const uno = <T>(r: Rel<T>): T | undefined => (Array.isArray(r) ? r[0] : (r ?? undefined));

const emitirSchema = z.object({
  eventoId: z.string().uuid(),
  tipoTicketId: z.string().uuid(),
  nombre: z.string().trim().min(2, "Ingresá el nombre del invitado.").max(100),
  email: z.string().trim().toLowerCase().max(120).optional().nullable().transform((v) => v || null),
  cantidad: z.coerce.number().int().min(1).max(20).default(1),
});

export async function entradasRoutes(app: FastifyInstance) {
  const lectura = { preHandler: exigir("admin", "rrpp", "staff") };

  app.get<{ Querystring: { eventoId?: string; estado?: string; q?: string } }>("/entradas", lectura, async (req) => {
    const { eventoId, estado } = req.query;
    if (!eventoId) throw new HttpError(400, "Indicá el evento.");
    await exigirEvento(req.usuario, eventoId);
    const q = (req.query.q ?? "").replace(/[%,()*\\]/g, " ").trim().slice(0, 60);
    const filas = await todas<any>(() => {
      let c = db()
        .from("entradas")
        .select("id, nombre, email, estado, usada_en, anulada_motivo, creada_en, orden_id, ci, numero_en_orden, titular_definido, transferencias, tipos_ticket(nombre, categoria), ordenes(numero, cantidad)")
        .eq("evento_id", eventoId)
        .order("creada_en", { ascending: false })
        .order("id"); // desempate: con 1.000+ filas los bloques no deben repetir ni saltarse filas
      if (["valida", "usada", "anulada"].includes(estado ?? "")) c = c.eq("estado", estado!);
      if (q) c = c.or(`nombre.ilike.%${q}%,email.ilike.%${q}%`);
      return c;
    });
    return filas.map((e) => {
      const t = uno<{ nombre: string; categoria: string }>(e.tipos_ticket);
      const o = uno<{ numero: number; cantidad: number }>(e.ordenes);
      return {
        id: e.id, nombre: e.nombre, email: e.email, estado: e.estado, usadaEn: e.usada_en, anuladaMotivo: e.anulada_motivo,
        creadaEn: e.creada_en, tipo: t?.nombre ?? "", categoria: t?.categoria ?? "", deOrden: !!e.orden_id,
        ci: e.ci, titularDefinido: e.titular_definido, transferencias: e.transferencias,
        ordenNumero: o ? Number(o.numero) : null, numeroEnOrden: e.numero_en_orden, totalOrden: o?.cantidad ?? null,
      };
    });
  });

  // Emisión manual (invitaciones / VIP / cortesías): admin y RRPP de ese evento.
  app.post("/entradas", { preHandler: exigir("admin", "rrpp") }, async (req, reply) => {
    const b = emitirSchema.parse(req.body);
    await exigirEvento(req.usuario, b.eventoId);
    if (b.email && !emailValido(b.email)) throw new HttpError(400, "El correo no tiene un formato válido.");
    const tokens = Array.from({ length: b.cantidad }, () => generarToken());
    // emitir_entradas valida tipo + cupo y escribe en UNA transacción (cupo atómico con muchos RRPP a la vez).
    const { data: ids, error } = await db().rpc("emitir_entradas", {
      p_evento: b.eventoId, p_tipo: b.tipoTicketId, p_nombre: b.nombre, p_email: b.email, p_tokens: tokens, p_user: req.usuario.id,
      p_org: req.usuario.orgId, // defensa en profundidad: la base también verifica la organización
    });
    if (error) throw errorDeFuncionSql(error.message) ?? new Error(error.message);
    const { data: tipo } = await db().from("tipos_ticket").select("nombre").eq("id", b.tipoTicketId).single();
    const data = (ids as string[]).map((id, i) => ({ id, token: tokens[i] }));

    let correo: { ok: boolean; error?: string } | null = null;
    if (b.email) {
      try {
        const { data: ev } = await db().from("eventos").select("nombre, fecha_inicio, lugar, direccion_url").eq("id", b.eventoId).single();
        await enviarEntradas(b.email, b.nombre, ev as DatosEvento, data.map((e) => ({ token: e.token, tipo: tipo?.nombre ?? "" })));
        correo = { ok: true };
      } catch (e) {
        correo = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    reply.code(201);
    return { ids: data.map((e) => e.id), correo };
  });

  app.post<{ Params: { id: string } }>("/entradas/:id/anular", { preHandler: exigir("admin") }, async (req) => {
    await exigirEntrada(req.usuario, req.params.id);
    const { motivo } = z.object({ motivo: z.string().trim().min(3, "Indicá un motivo.").max(300) }).parse(req.body);
    const { data, error } = await db()
      .from("entradas")
      .update({ estado: "anulada", anulada_en: new Date().toISOString(), anulada_motivo: motivo })
      .eq("id", req.params.id)
      .eq("estado", "valida") // una entrada ya usada no se anula
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new HttpError(409, "Solo se pueden anular entradas vigentes (no usadas ni ya anuladas).");
    return { ok: true };
  });

  // Corregir el titular (nombre y/o cédula) de una entrada vigente: lo hace el administrador, por ejemplo cuando el comprador
  // avisa el nombre de su acompañante. Queda registrado quién lo cambió y qué había antes.
  app.put<{ Params: { id: string } }>("/entradas/:id/titular", { preHandler: exigir("admin") }, async (req) => {
    await exigirEntrada(req.usuario, req.params.id);
    const body = (req.body ?? {}) as { nombre?: unknown; ci?: unknown };
    const nom = limpiarNombre(body.nombre);
    if (!nom.ok) throw new HttpError(400, "El nombre debe tener entre 2 y 100 letras.");
    const ci = body.ci === undefined ? undefined : limpiarCi(body.ci);
    if (ci && !ci.ok) throw new HttpError(400, "La cédula no es válida (4 a 20 letras o números).");
    const cambios: Record<string, unknown> = {};
    if (nom.nombre) { cambios.nombre = nom.nombre; cambios.titular_definido = true; }
    if (ci && ci.ok) cambios.ci = ci.ci;
    if (!Object.keys(cambios).length) throw new HttpError(400, "No hay nada para cambiar.");
    const { data: antes } = await db().from("entradas").select("nombre, ci").eq("id", req.params.id).single();
    const { data, error } = await db().from("entradas").update(cambios).eq("id", req.params.id).eq("estado", "valida").select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new HttpError(409, "Solo se pueden cambiar entradas vigentes (no usadas ni anuladas).");
    await registrarCambioEntrada(req.params.id, "titular", req.usuario.nombre, antes as { nombre: string; ci: string | null },
      { nombre: (cambios.nombre as string) ?? antes!.nombre, ci: "ci" in cambios ? (cambios.ci as string | null) : (antes!.ci as string | null) });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/entradas/:id/reenviar", { preHandler: exigir("admin", "rrpp") }, async (req) => {
    const { data: e } = await db()
      .from("entradas")
      .select("evento_id, nombre, email, token, estado, orden_id, tipos_ticket(nombre)")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!e) throw new HttpError(404, "Entrada no encontrada.");
    await exigirEvento(req.usuario, e.evento_id);
    if (e.estado !== "valida") throw new HttpError(409, "Solo se reenvían entradas vigentes.");
    let email = e.email as string | null;
    if (!email && e.orden_id) email = (await db().from("ordenes").select("email").eq("id", e.orden_id).single()).data?.email ?? null;
    if (!email) throw new HttpError(400, "Esta entrada no tiene un correo asociado.");
    const { data: ev } = await db().from("eventos").select("nombre, fecha_inicio, lugar, direccion_url").eq("id", e.evento_id).single();
    await enviarEntradas(email, e.nombre, ev as DatosEvento, [{ token: e.token, tipo: uno<{ nombre: string }>(e.tipos_ticket as Rel<{ nombre: string }>)?.nombre ?? "" }]);
    return { ok: true };
  });
}
