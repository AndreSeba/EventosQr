import type { FastifyRequest } from "fastify";
import { db } from "./lib/db";
import { requerido } from "./lib/config";
import { HttpError } from "./lib/errores";
import { leerToken } from "./lib/seguridad";

export type Rol = "superadmin" | "admin" | "rrpp" | "staff";
/** orgId es null solo para el superadmin (dueño del sistema). Todos los demás pertenecen a UNA organización. */
export type Usuario = { id: string; email: string; nombre: string; rol: Rol; orgId: string | null; orgNombre: string | null };

declare module "fastify" {
  interface FastifyRequest {
    usuario: Usuario;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const esUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

/** preHandler: exige sesión válida y uno de los roles. El rol/estado se lee de la BD en cada request,
 *  así desactivar a alguien (o a toda su organización) o cambiarle el rol tiene efecto inmediato.
 *  El superadmin cuenta como «admin» en las rutas de administrador; las rutas solo del dueño piden «superadmin». */
export function exigir(...roles: Rol[]) {
  return async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    const uid = leerToken(h?.startsWith("Bearer ") ? h.slice(7) : undefined, requerido("JWT_SECRET"));
    if (!uid) throw new HttpError(401, "Sesión no válida. Iniciá sesión de nuevo.");
    const { data, error } = await db()
      .from("usuarios")
      .select("id, email, nombre, rol, activo, org_id, organizaciones(nombre, activa)")
      .eq("id", uid)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const org = (Array.isArray(data?.organizaciones) ? data?.organizaciones[0] : data?.organizaciones) as { nombre: string; activa: boolean } | null | undefined;
    // Una organización desactivada deja sin acceso a todos sus usuarios (el superadmin no pertenece a ninguna)
    if (!data || !data.activo || (data.rol !== "superadmin" && !org?.activa)) throw new HttpError(401, "Sesión no válida. Iniciá sesión de nuevo.");
    const permitido = !roles.length || roles.includes(data.rol) || (data.rol === "superadmin" && roles.includes("admin"));
    if (!permitido) throw new HttpError(403, "No tenés permiso para esta acción.");
    req.usuario = { id: data.id, email: data.email, nombre: data.nombre, rol: data.rol, orgId: data.org_id, orgNombre: org?.nombre ?? null };
  };
}

export const esAdmin = (u: Usuario) => u.rol === "admin" || u.rol === "superadmin";

/** Ids de eventos que el usuario puede ver; null = todos (solo el superadmin).
 *  - admin: todos los eventos de SU organización.
 *  - rrpp / staff: solo los asignados, y siempre dentro de su organización. */
export async function eventosDe(u: Usuario): Promise<string[] | null> {
  if (u.rol === "superadmin") return null;
  if (!u.orgId) return []; // no debería ocurrir (restricción en la BD), pero se falla cerrado
  if (u.rol === "admin") {
    const { data, error } = await db().from("eventos").select("id").eq("org_id", u.orgId);
    if (error) throw new Error(error.message);
    return data.map((e) => e.id as string);
  }
  const { data, error } = await db()
    .from("evento_equipo")
    .select("evento_id, eventos!inner(org_id)")
    .eq("usuario_id", u.id)
    .eq("eventos.org_id", u.orgId);
  if (error) throw new Error(error.message);
  return data.map((r) => r.evento_id as string);
}

/** Un evento ajeno responde IGUAL que uno que no existe (404): no se revela si existe en otra organización. */
export async function exigirEvento(u: Usuario, eventoId: string): Promise<void> {
  if (!esUuid(eventoId)) throw new HttpError(404, "Evento no encontrado.");
  const ev = await eventosDe(u);
  if (ev && !ev.includes(eventoId)) throw new HttpError(404, "Evento no encontrado.");
}

/** Dado el id de un recurso que cuelga de un evento (orden, entrada, tipo), exige acceso a ese evento y devuelve el id del evento. */
async function eventoDe(tabla: "ordenes" | "entradas" | "tipos_ticket", id: string, u: Usuario, noEncontrado: string): Promise<string> {
  if (!esUuid(id)) throw new HttpError(404, noEncontrado);
  const { data, error } = await db().from(tabla).select("evento_id").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new HttpError(404, noEncontrado);
  try {
    await exigirEvento(u, data.evento_id);
  } catch {
    throw new HttpError(404, noEncontrado); // mismo mensaje que si no existiera
  }
  return data.evento_id as string;
}
export const exigirOrden = (u: Usuario, id: string) => eventoDe("ordenes", id, u, "La orden no existe.");
export const exigirEntrada = (u: Usuario, id: string) => eventoDe("entradas", id, u, "Entrada no encontrada.");
export const exigirTipo = (u: Usuario, id: string) => eventoDe("tipos_ticket", id, u, "Tipo no encontrado.");
