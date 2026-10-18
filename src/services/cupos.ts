import { db, todas } from "../lib/db";
import { HttpError } from "../lib/errores";

/** Entradas vivas (no anuladas) + unidades en órdenes pendientes. */
export async function ocupados(tipoId: string): Promise<number> {
  const { count, error } = await db()
    .from("entradas")
    .select("id", { count: "exact", head: true })
    .eq("tipo_ticket_id", tipoId)
    .neq("estado", "anulada");
  if (error) throw new Error(error.message);
  const pend = await todas<{ cantidad: number }>(() =>
    db().from("ordenes").select("cantidad").eq("tipo_ticket_id", tipoId).eq("estado", "Pendiente").order("creada_en"),
  );
  return (count ?? 0) + pend.reduce((s, o) => s + o.cantidad, 0);
}

/** null = sin límite. */
export async function disponibles(tipoId: string, cupo: number | null): Promise<number | null> {
  return cupo === null ? null : Math.max(0, cupo - (await ocupados(tipoId)));
}

/** `yaReservadas`: unidades de esta misma orden que ya cuentan como pendientes (al aprobar). */
export async function exigirCupo(tipoId: string, cupo: number | null, cantidad: number, yaReservadas = 0): Promise<void> {
  if (cupo === null) return;
  const libres = cupo - (await ocupados(tipoId)) + yaReservadas;
  if (cantidad > libres)
    throw new HttpError(409, libres <= 0 ? "Este tipo de ticket está agotado." : `Solo quedan ${libres} entrada(s) de este tipo.`);
}
