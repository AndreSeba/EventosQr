-- Mejoras de la página de compra. Idempotente; no cambia ningún dato existente.
-- acceso: token secreto del link de la orden (/o/<acceso>). El comprador ve ahí el estado y, si se aprobó, sus QR en pantalla:
--         aunque el correo no le llegue (por ejemplo, porque lo escribió mal), tiene su entrada.
--         Las órdenes que ya existen reciben uno al aplicar la migración (el valor por defecto se calcula fila por fila).
-- ref: promotor que trajo la venta (el link de venta con ?r=<nombre>).
-- edad_minima y whatsapp: datos del evento que se muestran en la página de compra.
alter table ordenes add column if not exists acceso text not null
  default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));
create unique index if not exists ordenes_acceso_uq on ordenes (acceso);
alter table ordenes add column if not exists ref text check (ref is null or ref ~ '^[a-z0-9-]{1,40}$');
alter table eventos add column if not exists edad_minima int check (edad_minima is null or edad_minima between 1 and 99);
alter table eventos add column if not exists whatsapp text check (whatsapp is null or whatsapp ~ '^\+[0-9]{8,15}$');
