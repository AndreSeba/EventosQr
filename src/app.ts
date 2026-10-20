import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { ZodError } from "zod";
import { numero } from "./lib/config";
import { HttpError } from "./lib/errores";
import { authRoutes } from "./routes/auth";
import { entradasRoutes } from "./routes/entradas";
import { eventosRoutes } from "./routes/eventos";
import { ordenesRoutes } from "./routes/ordenes";
import { publicoRoutes } from "./routes/publico";
import { scanRoutes } from "./routes/scan";
import { usuariosRoutes } from "./routes/usuarios";

export async function buildApp() {
  // TRUST_PROXY: número de proxies de confianza delante del API (ej. 1 o 2). Con "true" se confía en TODO el
  // encabezado X-Forwarded-For y cualquiera puede falsear su IP para esquivar el límite de intentos.
  const tp = process.env.TRUST_PROXY ?? "";
  const trustProxy = /^\d+$/.test(tp) ? (_addr: string, salto: number) => salto < Number(tp) : tp === "true";
  const app = Fastify({ logger: true, trustProxy, bodyLimit: 1_000_000 });

  await app.register(cors, {
    origin: (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean),
    methods: ["GET", "POST", "PUT", "DELETE"],
    // El navegador cachea la petición previa (OPTIONS) y no la repite en cada llamada: ahorra ~1 viaje por petición.
    maxAge: 86400,
  });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(multipart, { limits: { fileSize: numero("MAX_COMPROBANTE_MB", 2) * 1024 * 1024, files: 1, fields: 20 } });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues[0]?.message ?? "Datos inválidos." });
    if (err.statusCode === 429) return reply.code(429).send({ error: "Demasiadas solicitudes. Esperá un momento." });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: "Solicitud inválida." });
    req.log.error(err);
    return reply.code(500).send({ error: "Error interno." }); // nunca exponemos el mensaje crudo
  });

  app.get("/health", async () => ({ ok: true }));
  await app.register(async (api) => {
    await api.register(authRoutes);
    await api.register(publicoRoutes);
    await api.register(eventosRoutes);
    await api.register(ordenesRoutes);
    await api.register(entradasRoutes);
    await api.register(usuariosRoutes);
    await api.register(scanRoutes);
  }, { prefix: "/api" });

  return app;
}
