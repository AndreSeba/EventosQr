/** Error de negocio con status HTTP: el manejador global lo devuelve tal cual al cliente. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Traduce los `raise exception` de las funciones SQL atómicas (crear_orden, aprobar_orden, emitir_entradas). */
export function errorDeFuncionSql(message: string): HttpError | null {
  const cupo = /SIN_CUPO:(\d+)/.exec(message);
  if (cupo) {
    const n = Number(cupo[1]);
    return new HttpError(409, n <= 0 ? "Este tipo de ticket está agotado." : `Solo quedan ${n} entrada(s) de este tipo.`);
  }
  if (message.includes("EVENTO_NO_ENCONTRADO")) return new HttpError(404, "Evento no encontrado.");
  if (message.includes("ORDEN_NO_ENCONTRADA")) return new HttpError(404, "La orden no existe.");
  if (message.includes("ORDEN_YA_RESUELTA")) return new HttpError(409, "La orden ya fue resuelta.");
  if (message.includes("TIPO_ES_VENTA")) return new HttpError(400, "Los tickets de venta se generan al aprobar una compra. Usá un tipo de invitación o VIP.");
  if (message.includes("TIPO_INVALIDO")) return new HttpError(400, "Tipo de ticket inválido.");
  return null;
}
