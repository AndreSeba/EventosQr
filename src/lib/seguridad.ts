import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// ---------- Token de sesión (HMAC-SHA256, sin dependencias) ----------
const DURACION_MS = 12 * 3600 * 1000;
const firmar = (payload: string, secreto: string) => createHmac("sha256", secreto).update(payload).digest("base64url");

export function crearToken(uid: string, secreto: string, ahora = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ uid, exp: ahora + DURACION_MS })).toString("base64url");
  return `${payload}.${firmar(payload, secreto)}`;
}

/** Devuelve el id de usuario si la firma es válida y no expiró. */
export function leerToken(valor: string | undefined, secreto: string, ahora = Date.now()): string | null {
  if (!valor) return null;
  const [payload, firma] = valor.split(".");
  if (!payload || !firma) return null;
  const a = Buffer.from(firma);
  const b = Buffer.from(firmar(payload, secreto));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof uid === "string" && typeof exp === "number" && exp > ahora ? uid : null;
  } catch {
    return null;
  }
}

// ---------- Contraseñas (scrypt) ----------
export function hashPassword(pw: string): string {
  const sal = randomBytes(16);
  return `s1$${sal.toString("base64")}$${scryptSync(pw, sal, 64).toString("base64")}`;
}

export function verificarPassword(pw: string, almacenado: string): boolean {
  const [v, sal, hash] = almacenado.split("$");
  if (v !== "s1" || !sal || !hash) return false;
  const esperado = Buffer.from(hash, "base64");
  const real = scryptSync(pw, Buffer.from(sal, "base64"), esperado.length);
  return timingSafeEqual(real, esperado);
}

export const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Hash de relleno: se verifica contra él cuando el email no existe, para no filtrar su existencia por tiempo. */
export const HASH_RELLENO = hashPassword("relleno-" + randomBytes(8).toString("hex"));
