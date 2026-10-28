/** Titular de una entrada: nombre y cédula, siempre OPCIONALES para quien compra. */
export const CI_REGEX = /^[A-Za-z0-9][A-Za-z0-9 .-]{2,18}[A-Za-z0-9]$/; // 4 a 20 caracteres; la misma regla que el CHECK de la base

export type Titular = { nombre: string | null; ci: string | null };

/** "" o ausente → null. Una cédula mal escrita se rechaza (no se guarda ni se ignora en silencio). */
export function limpiarCi(v: unknown): { ok: true; ci: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, ci: null };
  if (typeof v !== "string") return { ok: false };
  const ci = v.trim().replace(/\s+/g, " ");
  if (!ci) return { ok: true, ci: null };
  return CI_REGEX.test(ci) ? { ok: true, ci } : { ok: false };
}

export function limpiarNombre(v: unknown): { ok: true; nombre: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, nombre: null };
  if (typeof v !== "string") return { ok: false };
  const nombre = v.trim().replace(/\s+/g, " ");
  if (!nombre) return { ok: true, nombre: null };
  return nombre.length >= 2 && nombre.length <= 100 ? { ok: true, nombre } : { ok: false };
}

/** Lo que llega al comprar: JSON `[{nombre, ci}, ...]`, uno por entrada (el nombre del primero se ignora: es el del comprador).
 *  Devuelve null si el comprador no escribió nada. */
export function validarTitulares(raw: unknown, cantidad: number): { ok: true; titulares: Titular[] | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, titulares: null };
  let arr: unknown;
  try { arr = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return { ok: false, error: "Los datos de los acompañantes no son válidos." }; }
  if (!Array.isArray(arr) || arr.length > cantidad) return { ok: false, error: "Los datos de los acompañantes no coinciden con la cantidad de entradas." };
  const out: Titular[] = [];
  for (let i = 0; i < cantidad; i++) {
    const it = (arr[i] ?? {}) as { nombre?: unknown; ci?: unknown };
    if (typeof it !== "object" || Array.isArray(it)) return { ok: false, error: "Los datos de los acompañantes no son válidos." };
    const n = limpiarNombre(it.nombre);
    if (!n.ok) return { ok: false, error: `El nombre del acompañante ${i + 1} debe tener entre 2 y 100 letras.` };
    const c = limpiarCi(it.ci);
    if (!c.ok) return { ok: false, error: `La cédula ${i === 0 ? "" : `del acompañante ${i + 1} `}no es válida (4 a 20 letras o números).` };
    out.push({ nombre: i === 0 ? null : n.nombre, ci: c.ci });
  }
  return { ok: true, titulares: out.every((t) => !t.nombre && !t.ci) ? null : out };
}

/** El link de la orden se puede compartir: la cédula no se muestra entera. */
export const ocultarCi = (ci: string | null): string | null => (ci ? `•••${ci.slice(-3)}` : null);