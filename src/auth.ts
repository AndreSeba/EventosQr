import type { FastifyRequest } from "fastify";
import { db } from "./lib/db";
import { requerido } from "./lib/config";
import { HttpError } from "./lib/errores";
import { leerToken } from "./lib/seguridad";

export type Rol = "admin" | "rrpp" | "staff";
export type Usuario = { id: string; email: string; nombre: string; rol: Rol };

declare module "fastify" {
  interface FastifyRequest {
    usuario: Usuario;
  }
}

/** preHandler: exige sesión válida y uno de los roles. El rol/estado se lee de la BD en cada request,
 *  así desactivar a alguien o cambiarle el rol tiene efecto inmediato. */
export function exigir(...roles: Rol[]) {
  return async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    const uid = leerToken(h?.startsWith("Bearer ") ? h.slice(7) : undefined, requerido("JWT_SECRET"));
    if (!uid) throw new HttpError(401, "Sesión no válida. Iniciá sesión de nuevo.");
    const { data, error } = await db().from("usuarios").select("id, email, nombre, rol, activo").eq("id", uid).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data || !data.activo) throw new HttpError(401, "Sesión no válida. Iniciá sesión de nuevo.");
    if (roles.length && !roles.includes(data.rol)) throw new HttpError(403, "No tenés permiso para esta acción.");
    req.usuario = { id: data.id, email: data.email, nombre: data.nombre, rol: data.rol };
  };
}

/** Ids de eventos que el usuario puede ver; null = todos (admin). */
export async function eventosDe(u: Usuario): Promise<string[] | null> {
  if (u.rol === "admin") return null;
  const { data, error } = await db().from("evento_equipo").select("evento_id").eq("usuario_id", u.id);
  if (error) throw new Error(error.message);
  return data.map((r) => r.evento_id as string);
}

export async function exigirEvento(u: Usuario, eventoId: string): Promise<void> {
  const ev = await eventosDe(u);
  if (ev && !ev.includes(eventoId)) throw new HttpError(403, "No tenés acceso a ese evento.");
}
