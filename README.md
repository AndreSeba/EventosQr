# EventosQr.Api

Backend de EventosQr: entradas digitales con QR de un solo uso para cualquier evento. El front está en el repo hermano `../EventosQr.Web` (mismo patrón que InventoryPlatform / InventoryPlatform.Web).

**Stack:** Node 20+ · Fastify 5 · TypeScript · Supabase (Postgres + Storage) · nodemailer (Gmail SMTP) · qrcode · zod · vitest.

## Estructura

```
src/
├── index.ts            # arranque + alta del primer admin
├── app.ts              # Fastify: CORS, rate limit, multipart, manejador de errores
├── auth.ts             # exigir(...roles), eventosDe(): permisos por rol y por evento
├── routes/             # una ruta por módulo (HTTP fino, sin lógica de negocio pesada)
│   ├── auth.ts  publico.ts  eventos.ts  ordenes.ts  entradas.ts  usuarios.ts  scan.ts
├── services/           # lógica de negocio: ordenes.ts (aprobar/rechazar/correo), cupos.ts
└── lib/                # db (Supabase), seguridad (token, scrypt), scan (escaneo atómico),
                        # mailer, tickets (token + QR), validar, multipart, ratelimit
supabase/schema.sql     # tablas, índices únicos, RLS y buckets
tests/core.test.ts
```

## Modelo

`usuarios` (rol admin | rrpp | staff) · `eventos` · `tipos_ticket` (nombre, precio, cupo, categoría venta | invitacion | vip) · `evento_equipo` (quién del equipo atiende cada evento) · `ordenes` (compras con comprobante) · `entradas` (cada QR: valida | usada | anulada).

## Roles

| Rol | Puede |
|---|---|
| `admin` | Todo: eventos, tipos, órdenes (aprobar/rechazar), usuarios, equipo, anular, escanear |
| `rrpp` | En los eventos asignados: ver lista de invitados y emitir invitaciones / VIP |
| `staff` | En los eventos asignados: escanear en la puerta y ver la lista |

## Endpoints (prefijo `/api`)

Público: `GET /public/eventos/:slug` · `POST /public/eventos/:slug/ordenes` (multipart).
Sesión: `POST /auth/login` · `GET /auth/me` · `POST /auth/cambiar-password`.
Eventos: `GET/POST /eventos` · `GET/PUT /eventos/:id` · `POST /eventos/:id/archivar` · `POST /eventos/:id/imagen?tipo=imagen|qr-pago` · `POST /eventos/:id/tipos` · `PUT /tipos/:id` · `PUT /eventos/:id/equipo` · `GET /eventos/:id/resumen`.
Órdenes (admin): `GET /ordenes` · `GET /ordenes/:id/comprobante` · `POST /ordenes/:id/aprobar|rechazar|reenviar`.
Entradas: `GET /entradas?eventoId&estado&q` · `POST /entradas` (invitación) · `POST /entradas/:id/anular` · `POST /entradas/:id/reenviar`.
Usuarios (admin): `GET/POST /usuarios` · `PUT /usuarios/:id`.
Puerta: `POST /scan {token}` → `VALIDA | YA_USADA | ANULADA | INVALIDA`.

## Seguridad

- Token de entrada: 192 bits del CSPRNG; el QR solo contiene el token.
- **Escaneo atómico:** `UPDATE entradas SET estado='usada' ... WHERE token=? AND estado='valida'` (+ filtro de eventos permitidos para el staff). Dos escaneos simultáneos: solo uno obtiene la fila.
- Sesión: token firmado HMAC (12 h) que se revalida contra la BD en cada request: desactivar a alguien o cambiarle el rol aplica al instante. Contraseñas con scrypt + sal. Login con rate limit por IP y por correo.
- Comprobantes: tipo por primeros bytes, tamaño máximo, bucket privado con URL firmada de 120 s.
- Unicidad en la BD: un correo y un comprobante (hash) por orden viva; cupos por tipo de ticket (cuentan entradas vivas y órdenes pendientes).
- Los errores 500 nunca devuelven el mensaje interno.

## Puesta en marcha

1. Supabase: crear proyecto, ejecutar `supabase/schema.sql` en el SQL Editor; copiar *Project URL* y clave `service_role`.
2. Gmail: activar verificación en 2 pasos y crear una *contraseña de aplicación* (<https://myaccount.google.com/apppasswords>). Límite ≈ 500 correos/día.
3. `copy .env.example .env` y completar (`JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, SMTP, `CORS_ORIGINS`, `FRONTEND_URL`).
4. `npm install` · `npm run dev` (http://localhost:4000). En el primer arranque con la tabla `usuarios` vacía se crea el admin con `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
5. `npm test` · `npm run typecheck` · `npm run build` · `npm start`.

## Despliegue gratis

Es un servidor Node normal. Opciones sin costo: **Render** (Web Service, build `npm install && npm run build`, start `npm start`; el plan gratis se duerme tras 15 min sin tráfico y tarda ~50 s en despertar: abrí la app unos minutos antes del evento), Koyeb o Fly.io. Cargá todas las variables de `.env.example` en el panel. Con `TRUST_PROXY=true` el rate limit usa la IP real.

## Límites conocidos

- El rate limit es en memoria por instancia (suficiente con una sola instancia).
- El correo real (SMTP) y la integración con Supabase no se prueban automáticamente: hacé una compra completa de prueba antes del evento.
- La prueba de concurrencia del escáner usa un almacén en memoria con la misma semántica; la atomicidad real la garantiza Postgres.

## Desarrollo y pruebas

Las pruebas se hacen SIEMPRE contra un Postgres local, nunca contra producci�n. Ver [dev/README.md](dev/README.md): 
pm run dev:db, 
pm run dev, 
pm run test:carga.

