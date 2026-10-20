export type TipoArchivo = { ext: "jpg" | "png" | "webp" | "pdf"; mime: string };

/** Decide el tipo por los primeros bytes, ignorando Content-Type y extensión. */
export function detectarTipo(b: Uint8Array): TipoArchivo | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x))
    return { ext: "png", mime: "image/png" };
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d)
    return { ext: "pdf", mime: "application/pdf" };
  if (
    b.length >= 12 &&
    String.fromCharCode(...b.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.subarray(8, 12)) === "WEBP"
  )
    return { ext: "webp", mime: "image/webp" };
  return null;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

export function emailValido(e: string): boolean {
  return e.length <= 120 && EMAIL.test(e);
}

import { normalizarTelefono } from "./contacto";

export type DatosOrden = { nombre: string; telefono: string; email: string; cantidad: number };

export function validarDatosOrden(
  raw: { nombre?: unknown; telefono?: unknown; email?: unknown; cantidad?: unknown },
  maxCantidad: number,
): { ok: true; datos: DatosOrden } | { ok: false; error: string } {
  const nombre = typeof raw.nombre === "string" ? raw.nombre.trim().replace(/\s+/g, " ") : "";
  const telefono = typeof raw.telefono === "string" ? raw.telefono.trim() : "";
  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  const cantidad = Number(raw.cantidad ?? 1);
  if (nombre.length < 2 || nombre.length > 100) return { ok: false, error: "Ingresá tu nombre completo." };
  const telefonoNormalizado = normalizarTelefono(telefono);
  if (!telefonoNormalizado)
    return { ok: false, error: "Ingresá un celular real: 8 dígitos que empiecen con 6 o 7 (ej. 71234598), o con código de país (+54…)." };
  if (!emailValido(email)) return { ok: false, error: "El correo no tiene un formato válido." };
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > maxCantidad)
    return { ok: false, error: `La cantidad de entradas debe ser entre 1 y ${maxCantidad}.` };
  return { ok: true, datos: { nombre, telefono: telefonoNormalizado, email, cantidad } };
}
