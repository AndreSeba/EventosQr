// Puerta de entrada del entorno de DESARROLLO: imita las rutas de Supabase que usa el API.
//   /rest/v1/*     → PostgREST (Postgres local)
//   /storage/v1/*  → almacenamiento en disco (dev/storage), con la misma interfaz que Supabase Storage
// Así el API corre sin cambios apuntando SUPABASE_URL a http://127.0.0.1:54321. Nunca toca producción.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, "storage");
const PUERTO = Number(process.env.GATEWAY_PORT ?? 54321);
const POSTGREST = process.env.POSTGREST_URL ?? "http://127.0.0.1:3001";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".pdf": "application/pdf" };
const leer = (req) => new Promise((ok, mal) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); req.on("error", mal); });
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

/** Evita salirse de la carpeta de almacenamiento con rutas tipo ../ */
function rutaSegura(bucket, objeto) {
  const p = path.resolve(RAIZ, bucket, objeto);
  return p.startsWith(path.resolve(RAIZ) + path.sep) ? p : null;
}

async function proxy(req, res, destino) {
  const cuerpo = ["GET", "HEAD"].includes(req.method) ? undefined : await leer(req);
  const h = { ...req.headers }; delete h.host; delete h["content-length"];
  const r = await fetch(destino, { method: req.method, headers: h, body: cuerpo, redirect: "manual" });
  const salida = {}; r.headers.forEach((v, k) => { if (!["content-encoding", "transfer-encoding", "content-length", "connection"].includes(k)) salida[k] = v; });
  res.writeHead(r.status, salida);
  res.end(Buffer.from(await r.arrayBuffer()));
}

const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);

    if (p.startsWith("/rest/v1/")) return await proxy(req, res, POSTGREST + p.slice("/rest/v1".length) + url.search);

    if (p.startsWith("/storage/v1/object/")) {
      const partes = p.slice("/storage/v1/object/".length).split("/");

      // POST /object/sign/{bucket}/{objeto}  → URL firmada
      if (req.method === "POST" && partes[0] === "sign") {
        const [bucket, ...obj] = partes.slice(1);
        const archivo = rutaSegura(bucket, obj.join("/"));
        if (!archivo || !fs.existsSync(archivo)) return json(res, 404, { error: "Not found" });
        return json(res, 200, { signedURL: `/object/sign/${bucket}/${obj.join("/")}?token=${randomBytes(8).toString("hex")}` });
      }
      // GET /object/public/{bucket}/{objeto}  o  /object/sign/{bucket}/{objeto}?token=
      if (req.method === "GET" && ["public", "sign"].includes(partes[0])) {
        const [bucket, ...obj] = partes.slice(1);
        const archivo = rutaSegura(bucket, obj.join("/"));
        if (!archivo || !fs.existsSync(archivo)) return json(res, 404, { error: "Not found" });
        res.writeHead(200, { "content-type": MIME[path.extname(archivo).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
        return res.end(fs.readFileSync(archivo));
      }
      // DELETE /object/{bucket}  con { prefixes: [...] }
      if (req.method === "DELETE" && partes.length === 1) {
        const { prefixes = [] } = JSON.parse((await leer(req)).toString() || "{}");
        const borrados = [];
        for (const pre of prefixes) { const a = rutaSegura(partes[0], pre); if (a && fs.existsSync(a)) { fs.rmSync(a); borrados.push({ name: pre }); } }
        return json(res, 200, borrados);
      }
      // POST|PUT /object/{bucket}/{objeto}  → subir (cuerpo crudo, como lo manda supabase-js con Uint8Array)
      if (["POST", "PUT"].includes(req.method) && partes.length >= 2) {
        const [bucket, ...obj] = partes;
        const archivo = rutaSegura(bucket, obj.join("/"));
        if (!archivo) return json(res, 400, { error: "Ruta inválida" });
        if (fs.existsSync(archivo) && req.headers["x-upsert"] !== "true") return json(res, 400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
        fs.mkdirSync(path.dirname(archivo), { recursive: true });
        fs.writeFileSync(archivo, await leer(req));
        return json(res, 200, { Id: randomBytes(8).toString("hex"), Key: `${bucket}/${obj.join("/")}` });
      }
    }
    json(res, 404, { error: "Ruta no soportada por el entorno de desarrollo", ruta: p });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e) });
  }
});

fs.mkdirSync(RAIZ, { recursive: true });
servidor.listen(PUERTO, "127.0.0.1", () => console.log(`Gateway de desarrollo en http://127.0.0.1:${PUERTO} (PostgREST: ${POSTGREST})`));
