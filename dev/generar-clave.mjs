// Genera (una sola vez) el secreto JWT del entorno de desarrollo, la config de PostgREST y las variables para el API.
// Es un secreto de desarrollo local: NO sirve en ningún otro lado y no se sube a git.
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const destino = path.join(AQUI, "clave-dev.json");
if (fs.existsSync(destino)) process.exit(0);

const secreto = randomBytes(32).toString("hex");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const cuerpo = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "service_role", iss: "eventosqr-dev", exp: 4102444800 })}`;
const jwt = `${cuerpo}.${createHmac("sha256", secreto).update(cuerpo).digest("base64url")}`;
fs.writeFileSync(destino, JSON.stringify({ secreto, serviceRoleKey: jwt }, null, 2));
fs.writeFileSync(path.join(AQUI, "postgrest.conf"), [
  'db-uri = "postgres://authenticator:authenticator@127.0.0.1:54329/eventosqr"',
  'db-schemas = "public"',
  'db-anon-role = "anon"',
  `jwt-secret = "${secreto}"`,
  'server-host = "127.0.0.1"',
  "server-port = 3001",
  "",
].join("\n"));
console.log("clave de desarrollo generada");
