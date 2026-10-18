import { randomBytes } from "node:crypto";
import QRCode from "qrcode";

/** 24 bytes aleatorios del CSPRNG = 192 bits, 32 caracteres base64url. */
export function generarToken(): string {
  return randomBytes(24).toString("base64url");
}

const FORMATO_TOKEN = /^[A-Za-z0-9_-]{32}$/;
export function tokenConFormato(t: unknown): t is string {
  return typeof t === "string" && FORMATO_TOKEN.test(t);
}

/** El QR contiene únicamente el token; no hay datos personales dentro. */
export function qrPng(token: string): Promise<Buffer> {
  return QRCode.toBuffer(token, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 480 });
}
