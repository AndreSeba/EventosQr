/** Error de negocio con status HTTP: el manejador global lo devuelve tal cual al cliente. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
