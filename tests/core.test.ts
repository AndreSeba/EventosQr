import { beforeAll, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import { escanear, type EntradaStore, type FilaEntrada } from "../src/lib/scan";
import { generarToken, qrPng, tokenConFormato } from "../src/lib/tickets";
import { crearToken, hashPassword, leerToken, verificarPassword } from "../src/lib/seguridad";
import { detectarTipo, validarDatosOrden } from "../src/lib/validar";
import { limitar } from "../src/lib/ratelimit";
import { normalizarTelefono, sugerirCorreo, verificarCorreoReal } from "../src/lib/contacto";

type Fila = FilaEntrada & { token: string };

/** Almacén en memoria con la misma semántica que el UPDATE ... WHERE estado='valida' (check-and-set sin interrupción). */
function storeFalso(filas: Fila[]): EntradaStore {
  const lat = () => new Promise<void>((r) => setTimeout(r, Math.random() * 5));
  return {
    async reclamar(token, ahora, _uid, permitidos) {
      await lat(); // simula la ida y vuelta a la BD
      const f = filas.find((x) => x.token === token);
      if (!f || f.estado !== "valida" || (permitidos && !permitidos.includes(f.eventoId))) return null;
      f.estado = "usada";
      f.usadaEn = ahora; // check-and-set síncrono = atómico
      return { nombre: f.nombre, tipo: f.tipo };
    },
    async buscar(token) {
      await lat();
      return filas.find((x) => x.token === token) ?? null;
    },
  };
}
const fila = (token: string, extra: Partial<Fila> = {}): Fila => ({ token, nombre: "Ana", tipo: "General", estado: "valida", usadaEn: null, eventoId: "ev1", ...extra });

describe("escaneo", () => {
  it("primera lectura VÁLIDA; la segunda YA_USADA con la hora del primer uso", async () => {
    const t = generarToken();
    const store = storeFalso([fila(t)]);
    const t1 = new Date("2026-10-31T21:00:00Z");
    expect(await escanear(store, t, "u1", null, () => t1)).toEqual({ estado: "VALIDA", nombre: "Ana", tipo: "General" });
    expect(await escanear(store, t, "u1", null, () => new Date("2026-10-31T22:00:00Z"))).toEqual({
      estado: "YA_USADA", nombre: "Ana", tipo: "General", usadaEn: t1.toISOString(),
    });
  });

  it("200 escaneos simultáneos del mismo QR: exactamente uno pasa", async () => {
    const t = generarToken();
    const store = storeFalso([fila(t)]);
    const rs = await Promise.all(Array.from({ length: 200 }, () => escanear(store, t, "u1", null)));
    expect(rs.filter((r) => r.estado === "VALIDA")).toHaveLength(1);
    expect(rs.filter((r) => r.estado === "YA_USADA")).toHaveLength(199);
  });

  it("entrada anulada → ANULADA, y nunca pasa", async () => {
    const t = generarToken();
    const store = storeFalso([fila(t, { estado: "anulada" })]);
    expect(await escanear(store, t, "u1", null)).toEqual({ estado: "ANULADA", nombre: "Ana" });
  });

  it("staff de otro evento: INVALIDA y la entrada queda sin usar", async () => {
    const t = generarToken();
    const filas = [fila(t, { eventoId: "evA" })];
    const store = storeFalso(filas);
    expect(await escanear(store, t, "u2", ["evB"])).toEqual({ estado: "INVALIDA" });
    expect(filas[0].estado).toBe("valida");
    expect((await escanear(store, t, "u3", ["evA"])).estado).toBe("VALIDA");
  });

  it("tokens inexistentes o mal formados son INVALIDA", async () => {
    const store = storeFalso([]);
    expect(await escanear(store, generarToken(), "u", null)).toEqual({ estado: "INVALIDA" });
    for (const malo of ["", "abc", null, 42, "x".repeat(33), "' or 1=1 --" + "a".repeat(30)])
      expect(await escanear(store, malo, "u", null)).toEqual({ estado: "INVALIDA" });
  });
});

describe("tokens y QR", () => {
  it("192 bits, únicos y con formato", () => {
    const set = new Set(Array.from({ length: 5000 }, generarToken));
    expect(set.size).toBe(5000);
    for (const t of set) expect(tokenConFormato(t)).toBe(true);
    expect(Buffer.from([...set][0], "base64url")).toHaveLength(24);
  });
  it("el PNG del QR se decodifica y devuelve exactamente el token", async () => {
    const token = generarToken();
    const png = PNG.sync.read(await qrPng(token));
    expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data).toBe(token);
  });
});

describe("seguridad", () => {
  const sec = "s".repeat(32);
  it("token de sesión: firma, secreto, expiración y manipulación", () => {
    const t = crearToken("user-1", sec, 1000);
    expect(leerToken(t, sec, 2000)).toBe("user-1");
    expect(leerToken(t, "otro", 2000)).toBeNull();
    expect(leerToken(t, sec, 1000 + 13 * 3600 * 1000)).toBeNull();
    const [, f] = t.split(".");
    const falso = Buffer.from(JSON.stringify({ uid: "admin", exp: 9e15 })).toString("base64url");
    expect(leerToken(`${falso}.${f}`, sec, 2000)).toBeNull();
    expect(leerToken(undefined, sec)).toBeNull();
  });
  it("contraseñas con scrypt", () => {
    const h = hashPassword("Clave-Segura-1");
    expect(h).not.toContain("Clave-Segura-1");
    expect(verificarPassword("Clave-Segura-1", h)).toBe(true);
    expect(verificarPassword("otra", h)).toBe(false);
    expect(hashPassword("Clave-Segura-1")).not.toBe(h); // sal distinta
  });
});

describe("validación", () => {
  it("tipo de archivo por bytes", () => {
    expect(detectarTipo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe("jpg");
    expect(detectarTipo(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.ext).toBe("png");
    expect(detectarTipo(new TextEncoder().encode("%PDF-1.7"))?.ext).toBe("pdf");
    expect(detectarTipo(new TextEncoder().encode("<script>alert(1)</script>"))).toBeNull();
  });
  it("datos de la orden", () => {
    expect(validarDatosOrden({ nombre: " Ana  Pérez ", telefono: "+591 7938-4512", email: " ANA@Mail.com ", cantidad: "2" }, 5)).toEqual({
      ok: true, datos: { nombre: "Ana Pérez", telefono: "+59179384512", email: "ana@mail.com", cantidad: 2 },
    });
    for (const mal of [
      { nombre: "A", telefono: "79384512", email: "a@b.co", cantidad: 1 },
      { nombre: "Ana", telefono: "abc", email: "a@b.co", cantidad: 1 },
      { nombre: "Ana", telefono: "79384512", email: "x", cantidad: 1 },
      { nombre: "Ana", telefono: "79384512", email: "a@b.co", cantidad: 6 },
    ]) expect(validarDatosOrden(mal, 5).ok).toBe(false);
  });
  it("rate limit", () => {
    for (let i = 0; i < 3; i++) expect(limitar("k", 3, 1000, 0)).toBe(true);
    expect(limitar("k", 3, 1000, 10)).toBe(false);
    expect(limitar("k", 3, 1000, 2000)).toBe(true);
  });
});

describe("correo por la API de Gmail", () => {
  it("renueva el token, arma el MIME con los QR incrustados y lo envía por HTTPS (sin SMTP)", async () => {
    Object.assign(process.env, { GMAIL_REFRESH_TOKEN: "rt", GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "sec", SMTP_USER: "envia@gmail.com" });
    const llamadas: { url: string; body: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { body: unknown }) => {
      llamadas.push({ url: String(url), body: String(init.body) });
      return String(url).includes("oauth2") ? Response.json({ access_token: "at", expires_in: 3600 }) : Response.json({ id: "m1" });
    }) as unknown as typeof fetch;
    try {
      const { enviarEntradas } = await import("../src/lib/mailer");
      const token = generarToken();
      await enviarEntradas("comprador@test.com", "Ana", { nombre: "JIWILIN", fecha_inicio: "2026-10-31T00:00:00Z", lugar: null, direccion_url: null }, [{ token, tipo: "Muerto soltero" }]);
      expect(llamadas[0].url).toContain("oauth2.googleapis.com/token");
      expect(llamadas[0].body).toContain("grant_type=refresh_token");
      expect(llamadas[1].url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
      const mime = Buffer.from(JSON.parse(llamadas[1].body).raw, "base64url").toString();
      expect(mime).toContain("To: comprador@test.com");
      expect(mime).toContain("Subject: Tu entrada para JIWILIN");
      expect(mime).toContain("Content-ID: <qr0>"); // QR incrustado
      expect(mime).toContain("image/png");
    } finally {
      globalThis.fetch = original;
      for (const k of ["GMAIL_REFRESH_TOKEN", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "SMTP_USER"]) delete process.env[k];
    }
  });
});

describe("teléfono y correo reales", () => {
  it("normaliza celulares de Bolivia y acepta internacionales", () => {
    expect(normalizarTelefono("79384512")).toBe("+59179384512");
    expect(normalizarTelefono("793 84 512")).toBe("+59179384512");
    expect(normalizarTelefono("+591 7938-4512")).toBe("+59179384512");
    expect(normalizarTelefono("59179384512")).toBe("+59179384512");
    expect(normalizarTelefono("0059161234598")).toBe("+59161234598");
    expect(normalizarTelefono("+54 9 11 5938 4721")).toBe("+5491159384721");
  });
  it("rechaza números imposibles o inventados", () => {
    for (const mal of ["", "abc", "12345", "51234598", "7938451", "793845123", "70000000", "77777777", "71234567", "76543210", "71717171",
      "+591 12345678", "+0 1234567", "+1 123", "+591 6000 0000"])
      expect(normalizarTelefono(mal), mal).toBeNull();
  });
  it("sugiere la corrección de errores de tipeo típicos", () => {
    expect(sugerirCorreo("ana@gmial.com")).toBe("ana@gmail.com");
    expect(sugerirCorreo("ana@hotmial.com")).toBe("ana@hotmail.com");
    expect(sugerirCorreo("ana@gmail.com")).toBeNull();
  });
  it("verifica el dominio (DNS), bloquea desechables y tolera fallos de DNS", async () => {
    const dns = (respuestas: Record<string, boolean | null>) => async (d: string) => (d in respuestas ? respuestas[d] : null);
    expect(await verificarCorreoReal("a@real-uno.com", dns({ "real-uno.com": true }))).toEqual({ ok: true });
    const falso = await verificarCorreoReal("a@no-existe-dos.com", dns({ "no-existe-dos.com": false }));
    expect(falso.ok).toBe(false);
    const tipeo = await verificarCorreoReal("a@gmial.com", dns({}));
    expect(tipeo.ok === false && tipeo.error).toContain("a@gmail.com");
    expect((await verificarCorreoReal("a@mailinator.com", dns({ "mailinator.com": true }))).ok).toBe(false);
    expect(await verificarCorreoReal("a@dns-caido-tres.com", dns({ "dns-caido-tres.com": null }))).toEqual({ ok: true }); // sin respuesta de DNS: no se bloquea al comprador
  });
});

describe("API (sin base de datos)", () => {
  let app: Awaited<ReturnType<typeof import("../src/app").buildApp>>;
  beforeAll(async () => {
    process.env.JWT_SECRET = "t".repeat(32);
    const { buildApp } = await import("../src/app");
    app = await buildApp();
  });
  it("health", async () => {
    expect((await app.inject("/health")).statusCode).toBe(200);
  });
  it("rutas protegidas devuelven 401 sin token o con token falso", async () => {
    for (const [m, u] of [["GET", "/api/eventos"], ["POST", "/api/scan"], ["GET", "/api/usuarios"], ["GET", "/api/ordenes"]] as const) {
      expect((await app.inject({ method: m, url: u })).statusCode).toBe(401);
      expect((await app.inject({ method: m, url: u, headers: { authorization: "Bearer a.b" } })).statusCode).toBe(401);
    }
  });
  it("login con cuerpo inválido → 400", async () => {
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: {} })).statusCode).toBe(400);
  });
});
