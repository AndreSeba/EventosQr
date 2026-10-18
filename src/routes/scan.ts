import type { FastifyInstance } from "fastify";
import { eventosDe, exigir } from "../auth";
import { supabaseEntradaStore } from "../lib/db";
import { escanear } from "../lib/scan";

export async function scanRoutes(app: FastifyInstance) {
  app.post("/scan", { preHandler: exigir("admin", "staff"), config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const token = (req.body as { token?: unknown } | null)?.token;
    return escanear(supabaseEntradaStore, token, req.usuario.id, await eventosDe(req.usuario));
  });
}
