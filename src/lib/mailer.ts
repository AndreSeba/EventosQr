import nodemailer from "nodemailer";
import { requerido } from "./config";
import { qrPng } from "./tickets";

export type DatosEvento = { nombre: string; fecha_inicio: string; lugar: string | null; direccion_url: string | null };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

let _t: ReturnType<typeof nodemailer.createTransport> | null = null;
function transporte() {
  if (_t) return _t;
  const puerto = Number(process.env.SMTP_PORT ?? 465);
  _t = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "smtp.gmail.com",
    port: puerto,
    secure: puerto === 465,
    auth: { user: requerido("SMTP_USER"), pass: requerido("SMTP_PASS") },
    // Si el hosting bloquea SMTP (Render gratis lo hace), fallar en segundos y no tras 2 minutos
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return _t;
}

const remitente = () => `"${(process.env.MAIL_FROM_NAME ?? "EventosQr").replace(/"/g, "")}" <${requerido("SMTP_USER")}>`;

function marco(ev: DatosEvento, titulo: string, cuerpo: string) {
  const fecha = new Date(ev.fecha_inicio).toLocaleString("es-BO", { dateStyle: "full", timeStyle: "short", timeZone: "America/La_Paz" });
  const mapa = ev.direccion_url && /^https?:\/\//.test(ev.direccion_url)
    ? ` · <a style="color:#d4d4d4" href="${esc(ev.direccion_url)}">Ver ubicación</a>` : "";
  return `
<div style="background:#000;padding:24px;font-family:Arial,sans-serif;color:#eee">
  <div style="max-width:480px;margin:auto;background:#0e0e0e;border:1px solid #333;border-radius:12px;padding:24px">
    <h1 style="color:#fff;margin:0 0 4px">${esc(ev.nombre)}</h1>
    <p style="margin:0 0 16px;color:#aaa">${esc(fecha)}${ev.lugar ? " · " + esc(ev.lugar) : ""}${mapa}</p>
    <h2 style="margin:0 0 12px">${titulo}</h2>
    ${cuerpo}
  </div>
</div>`;
}

export async function enviarEntradas(para: string, nombre: string, ev: DatosEvento, tokens: { token: string; tipo: string }[]): Promise<void> {
  const qrs = await Promise.all(tokens.map((t) => qrPng(t.token)));
  const imgs = qrs
    .map(
      (_, i) => `<div style="text-align:center;margin:16px 0;background:#fff;border-radius:8px;padding:12px">
        <div style="color:#000;font-size:13px">${esc(tokens[i].tipo)} · Entrada ${i + 1} de ${qrs.length}</div>
        <img src="cid:qr${i}" width="240" height="240" alt="QR entrada ${i + 1}"/></div>`,
    )
    .join("");
  await transporte().sendMail({
    from: remitente(),
    to: para,
    subject: `Tu entrada para ${ev.nombre}`,
    html: marco(ev, `¡Hola ${esc(nombre)}, esta es tu entrada!`,
      `<p>Presentá este código QR en la puerta. <b>Cada QR se puede usar una sola vez</b>: no lo compartas ni lo publiques.</p>${imgs}`),
    attachments: qrs.map((content, i) => ({ filename: `entrada-${i + 1}.png`, content, cid: `qr${i}`, contentType: "image/png" })),
  });
}

export async function enviarRechazo(para: string, nombre: string, ev: DatosEvento, motivo: string): Promise<void> {
  await transporte().sendMail({
    from: remitente(),
    to: para,
    subject: `Sobre tu compra para ${ev.nombre}`,
    html: marco(ev, "No pudimos aprobar tu pago",
      `<p>Hola ${esc(nombre)}, revisamos tu comprobante y no pudimos aprobarlo.</p>
       <p style="background:#1a1a1a;padding:12px;border-radius:8px"><b>Motivo:</b> ${esc(motivo)}</p>
       <p>Podés volver a intentarlo desde la página del evento con un comprobante correcto.</p>`),
  });
}
