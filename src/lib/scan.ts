import { tokenConFormato } from "./tickets";

/** Datos del titular que el personal de la puerta puede comparar con la persona (todos opcionales). */
export type DatosTitular = {
  ci?: string | null;
  /** «Entrada 2 de 3» de la orden de compra (null en invitaciones manuales). */
  numeroEnOrden?: number | null;
  totalOrden?: number | null;
  /** false = lleva el nombre del comprador porque nadie escribió el del acompañante. */
  titularDefinido?: boolean;
};

export type ResultadoEscaneo =
  | ({ estado: "VALIDA"; nombre: string; tipo: string } & DatosTitular)
  | ({ estado: "YA_USADA"; nombre: string; tipo: string; usadaEn: string } & DatosTitular)
  | { estado: "ANULADA"; nombre: string }
  | { estado: "INVALIDA" };

export type FilaEntrada = { nombre: string; tipo: string; estado: "valida" | "usada" | "anulada"; usadaEn: string | null; eventoId: string } & DatosTitular;

/** Contrato de almacenamiento. `reclamar` DEBE ser atómico (un único UPDATE ... WHERE estado='valida'). */
export interface EntradaStore {
  /** `eventosPermitidos` null = todos. Devuelve la fila si ganó, null si no. */
  reclamar(token: string, ahoraIso: string, usuarioId: string, eventosPermitidos: string[] | null): Promise<({ nombre: string; tipo: string } & DatosTitular) | null>;
  buscar(token: string): Promise<FilaEntrada | null>;
}

export async function escanear(
  store: EntradaStore,
  token: unknown,
  usuarioId: string,
  eventosPermitidos: string[] | null,
  ahora: () => Date = () => new Date(),
): Promise<ResultadoEscaneo> {
  if (!tokenConFormato(token)) return { estado: "INVALIDA" };
  const ganada = await store.reclamar(token, ahora().toISOString(), usuarioId, eventosPermitidos);
  if (ganada) return { estado: "VALIDA", ...ganada };
  const f = await store.buscar(token);
  // No existe, o es de un evento que este usuario no atiende: no revelamos nada más.
  if (!f || (eventosPermitidos && !eventosPermitidos.includes(f.eventoId))) return { estado: "INVALIDA" };
  if (f.estado === "anulada") return { estado: "ANULADA", nombre: f.nombre };
  return { estado: "YA_USADA", nombre: f.nombre, tipo: f.tipo, usadaEn: f.usadaEn ?? "", ci: f.ci, numeroEnOrden: f.numeroEnOrden, totalOrden: f.totalOrden, titularDefinido: f.titularDefinido };
}
