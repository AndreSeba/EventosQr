import { promises as dns } from "node:dns";

// ============================ Teléfono ============================

/** Rachas como 123456 o 987654 (o 6+ dígitos iguales) delatan un número inventado. */
function pareceInventado(num: string): boolean {
  if (new Set(num).size <= 3) return true; // 70000000, 77777777, 71717171…
  let asc = 1, desc = 1;
  for (let i = 1; i < num.length; i++) {
    const d = Number(num[i]) - Number(num[i - 1]);
    asc = d === 1 ? asc + 1 : 1;
    desc = d === -1 ? desc + 1 : 1;
    if (asc >= 6 || desc >= 6) return true;
  }
  return false;
}

/** Devuelve el teléfono normalizado ("+59171234567") o null si no es un número plausible.
 *  Bolivia: celular de 8 dígitos que empieza con 6 o 7 (con o sin +591). Otros países: +código y 8-15 dígitos. */
export function normalizarTelefono(entrada: string): string | null {
  const s = entrada.trim();
  if (!/^[+\d\s().-]{7,25}$/.test(s)) return null;
  let digitos = s.replace(/\D/g, "");
  let internacional = s.startsWith("+");
  if (!internacional && digitos.startsWith("00")) { digitos = digitos.slice(2); internacional = true; }

  let local: string;
  let normalizado: string;
  if (internacional && digitos.startsWith("591")) {
    local = digitos.slice(3);
    if (!/^[67]\d{7}$/.test(local)) return null;
    normalizado = `+591${local}`;
  } else if (!internacional && digitos.startsWith("591") && digitos.length === 11) {
    local = digitos.slice(3);
    if (!/^[67]\d{7}$/.test(local)) return null;
    normalizado = `+591${local}`;
  } else if (!internacional) {
    if (!/^[67]\d{7}$/.test(digitos)) return null;
    local = digitos;
    normalizado = `+591${digitos}`;
  } else {
    if (digitos.length < 8 || digitos.length > 15 || digitos.startsWith("0")) return null;
    local = digitos.slice(-8);
    normalizado = `+${digitos}`;
  }
  return pareceInventado(local) ? null : normalizado;
}

// ============================= Correo =============================

const ERRORES_COMUNES: Record<string, string> = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmal.com": "gmail.com", "gamil.com": "gmail.com", "gmail.co": "gmail.com",
  "gmail.con": "gmail.com", "gmail.cm": "gmail.com", "gmaill.com": "gmail.com", "gnail.com": "gmail.com", "gmil.com": "gmail.com",
  "gmail.om": "gmail.com", "gmeil.com": "gmail.com", "hotmial.com": "hotmail.com", "hotmal.com": "hotmail.com", "hotmai.com": "hotmail.com",
  "hotmail.con": "hotmail.com", "hotmail.co": "hotmail.com", "outlok.com": "outlook.com", "outloo.com": "outlook.com", "outlook.con": "outlook.com",
  "yahooo.com": "yahoo.com", "yaho.com": "yahoo.com", "yahoo.con": "yahoo.com", "yahoo.co": "yahoo.com", "icloud.con": "icloud.com", "iclod.com": "icloud.com",
};

const DESECHABLES = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "sharklasers.com", "10minutemail.com", "10minutemail.net",
  "tempmail.com", "temp-mail.org", "temp-mail.io", "yopmail.com", "yopmail.net", "trashmail.com", "getnada.com", "nada.email", "maildrop.cc",
  "dispostable.com", "fakeinbox.com", "throwawaymail.com", "mohmal.com", "emailondeck.com", "tempail.com", "mintemail.com", "mailnesia.com",
  "spamgourmet.com", "tempinbox.com", "burnermail.io", "discard.email", "mailcatch.com", "moakt.com", "inboxkitten.com", "tmpmail.org",
]);

/** Si el dominio es un error de tipeo típico, devuelve el correo corregido para sugerirlo. */
export function sugerirCorreo(email: string): string | null {
  const [usuario, dominio] = email.split("@");
  const bueno = dominio && ERRORES_COMUNES[dominio];
  return bueno ? `${usuario}@${bueno}` : null;
}

type Resolver = (dominio: string) => Promise<boolean | null>;
const cache = new Map<string, { ok: boolean; hasta: number }>();

/** ¿El dominio puede recibir correo? true/false con certeza; null si el DNS no respondió (no se bloquea al comprador). */
const resolverDns: Resolver = async (dominio) => {
  const conTiempo = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), 3000))]);
  try {
    return (await conTiempo(dns.resolveMx(dominio))).length > 0;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "ENODATA" && code !== "ENOTFOUND") return null;
  }
  try { // sin MX, el estándar permite recibir en el registro A/AAAA del dominio
    return (await conTiempo(dns.resolve4(dominio))).length > 0;
  } catch (e) {
    const code = (e as { code?: string }).code;
    return code === "ENODATA" || code === "ENOTFOUND" ? false : null;
  }
};

export async function verificarCorreoReal(
  email: string,
  resolver: Resolver = resolverDns,
  ahora = Date.now(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const dominio = email.split("@")[1]?.toLowerCase() ?? "";
  const sugerido = sugerirCorreo(email);
  if (sugerido) return { ok: false, error: `¿Quisiste decir ${sugerido}? Revisá cómo escribiste tu correo.` };
  if (DESECHABLES.has(dominio)) return { ok: false, error: "Usá un correo real y personal: los correos temporales no se aceptan." };
  const guardado = cache.get(dominio);
  let recibe: boolean | null;
  if (guardado && guardado.hasta > ahora) recibe = guardado.ok;
  else {
    recibe = await resolver(dominio);
    if (recibe !== null) cache.set(dominio, { ok: recibe, hasta: ahora + 3600_000 });
  }
  if (recibe === false) return { ok: false, error: `El dominio «${dominio}» no existe o no recibe correos. Revisá tu correo.` };
  return { ok: true };
}
