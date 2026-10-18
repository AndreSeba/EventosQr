import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requerido } from "./config";
import type { EntradaStore } from "./scan";

let cliente: SupabaseClient | null = null;

/** Cliente service_role: solo servidor. Las tablas tienen RLS sin políticas. */
export function db(): SupabaseClient {
  cliente ??= createClient(requerido("SUPABASE_URL"), requerido("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cliente;
}

export const BUCKET_COMPROBANTES = "comprobantes";
export const BUCKET_PUBLICO = "publico";

export const urlPublica = (path: string | null): string | null =>
  path ? db().storage.from(BUCKET_PUBLICO).getPublicUrl(path).data.publicUrl : null;

/** Supabase devuelve máx. 1000 filas por consulta: esto pagina hasta agotar. */
export async function todas<T>(construir: () => { range(a: number, b: number): PromiseLike<{ data: unknown; error: { message: string } | null }> }): Promise<T[]> {
  const out: T[] = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await construir().range(desde, desde + 999);
    if (error) throw new Error(error.message);
    const filas = data as T[];
    out.push(...filas);
    if (filas.length < 1000) return out;
  }
}

type Rel<T> = T | T[] | null;
const uno = <T>(r: Rel<T>): T | undefined => (Array.isArray(r) ? r[0] : (r ?? undefined));

export const supabaseEntradaStore: EntradaStore = {
  async reclamar(token, ahoraIso, usuarioId, eventosPermitidos) {
    // Un solo UPDATE condicional: Postgres serializa las escrituras sobre la fila, así que de dos
    // escaneos simultáneos solo uno ve estado='valida' y obtiene la fila de vuelta.
    let q = db()
      .from("entradas")
      .update({ estado: "usada", usada_en: ahoraIso, usada_por: usuarioId })
      .eq("token", token)
      .eq("estado", "valida");
    if (eventosPermitidos) q = q.in("evento_id", eventosPermitidos);
    const { data, error } = await q.select("nombre, tipos_ticket(nombre)");
    if (error) throw new Error(error.message);
    if (!data || data.length !== 1) return null;
    const t = uno(data[0].tipos_ticket as Rel<{ nombre: string }>);
    return { nombre: data[0].nombre as string, tipo: t?.nombre ?? "" };
  },
  async buscar(token) {
    const { data, error } = await db()
      .from("entradas")
      .select("nombre, estado, usada_en, evento_id, tipos_ticket(nombre)")
      .eq("token", token)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const t = uno(data.tipos_ticket as Rel<{ nombre: string }>);
    return { nombre: data.nombre, tipo: t?.nombre ?? "", estado: data.estado, usadaEn: data.usada_en, eventoId: data.evento_id };
  },
};
