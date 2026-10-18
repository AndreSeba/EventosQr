import type { FastifyRequest } from "fastify";
import { HttpError } from "./errores";

/** Lee un formulario multipart con campos de texto y como máximo un archivo (`campoArchivo`). */
export async function leerFormulario(req: FastifyRequest, campoArchivo: string) {
  const campos: Record<string, string> = {};
  let archivo: Uint8Array | null = null;
  try {
    for await (const parte of req.parts()) {
      if (parte.type === "file") {
        const buf = await parte.toBuffer(); // lanza si supera el límite configurado
        if (parte.fieldname === campoArchivo && buf.length > 0) archivo = new Uint8Array(buf);
      } else if (typeof parte.value === "string") {
        campos[parte.fieldname] = parte.value;
      }
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "FST_REQ_FILE_TOO_LARGE") throw new HttpError(413, "El archivo es demasiado grande.");
    throw new HttpError(400, "Formulario inválido.");
  }
  return { campos, archivo };
}
