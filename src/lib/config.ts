export function requerido(nombre: string): string {
  const v = process.env[nombre];
  if (!v) throw new Error(`Falta la variable de entorno ${nombre}`);
  return v;
}

export function numero(nombre: string, porDefecto: number): number {
  const n = Number(process.env[nombre]);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
}

export const frontendUrl = () => (process.env.FRONTEND_URL ?? "http://localhost:5173").replace(/\/$/, "");
