# EventosQr — Pendientes

Última actualización: 24/10/2026.

## Después del evento JIWILIN (30/10/2026)

### Migrar de npm a pnpm (regla del usuario: nunca instalar con npm, por seguridad)

- [ ] `EventosQr.Api` y `EventosQr.Web` se crearon con npm (tienen `package-lock.json`). Migrar a pnpm: `pnpm import` para convertir el bloqueo,
      borrar `package-lock.json`, revisar los scripts de instalación bloqueados por pnpm y aprobar solo los necesarios.
- [ ] Cambiar los comandos de build en Render: API `pnpm install --frozen-lockfile && pnpm run build` (antes `npm install --include=dev && npm run build`),
      Web igual; activar `corepack enable` o fijar `packageManager` en `package.json`. Probar primero en desarrollo; NO cambiar producción antes del evento.
- [ ] Actualizar `render.yaml` y el README con los comandos nuevos.

### Opción B: sistema multi-cliente (varias organizaciones en una sola instalación)

**ESTADO (24/10/2026): IMPLEMENTADA Y PROBADA EN DESARROLLO, falta publicarla.** Rama multi-cliente; pasos en [docs/RAMAS.md](docs/RAMAS.md). Pendiente de decidir: correo por cliente y textos legales.

**Para qué:** vender el sistema por evento a distintos clientes sin que se crucen los datos.
**Cuándo:** NO tocar producción antes del evento. Desarrollar en una copia y publicar después del 31/10.

**Situación actual (por qué hace falta):** el sistema es de un solo dueño. El rol `admin` ve TODOS los eventos, órdenes,
compradores y comprobantes. No darle rol `admin` a un cliente nuevo en esta instalación.

**Alternativa descartada por ahora (opción A, una instalación por cliente):** aísla del todo, pero Supabase gratis permite solo
2 proyectos activos (ya hay `controlMarcaciones` y `EventosQr`) y cada actualización habría que repetirla por cliente.

**Diseño propuesto**
- Tabla `organizaciones` (id, nombre, slug, activa). `usuarios.org_id` y `eventos.org_id` (obligatorio en eventos).
  Todo lo demás (tipos, órdenes, entradas, equipo) cuelga del evento.
- Rol nuevo `superadmin` (el dueño del sistema): crea organizaciones, ve todo. El rol `admin` queda limitado a su organización.
- La regla de aislamiento en UN solo lugar del código: cada ruta que recibe un id (orden, entrada, tipo, evento, usuario)
  debe verificar que pertenece a la organización del usuario. Hoy `exigirEvento` / `eventosDe` en `src/auth.ts` es el punto de partida.
- Funciones SQL (`crear_orden`, `aprobar_orden`, `emitir_entradas`, `resumen_evento`) y consultas del escáner: revisar que no crucen organizaciones.
- **Pruebas automáticas de aislamiento** (obligatorias): dos organizaciones; con un usuario de una, intentar leer, aprobar, rechazar,
  anular, reenviar, emitir y escanear cosas de la otra. Todo debe fallar (404/403). Repetir el simulador de carga con 2 organizaciones.
- Pantalla para el superadmin: crear organización y su primer administrador.
- Al terminar un evento: poder archivar y luego borrar sus datos (comprobantes incluidos).

**Decisiones del dueño antes de empezar**
1. **Correo:** hoy sale de una sola cuenta de Gmail (~500 correos/día compartidos). Para varios clientes: dominio propio con un servicio de
   correo (Brevo, Resend, etc.) o que cada organización conecte el suyo.
2. **Cobro:** precio fijo por evento, por entrada vendida o ambos (se gestiona fuera del sistema).
3. **Legal:** aviso de privacidad y términos de uso (se guardan nombre, celular y correo de compradores).

**Ya resuelto para multi-cliente:** cada evento tiene su propio QR de pago, así que el dinero va directo a la cuenta de cada cliente.

### Mejoras de la compra (rama `mejoras-compra`, API y Web) — HECHAS EN DESARROLLO, falta publicarlas

Ideas tomadas de otra ticketera y probadas en local (25/10/2026). Dependen de multi-cliente: se publican con él o después.
Hechas: link de la orden con el QR en pantalla (`/o/<token>`) y «Mis entradas» en el teléfono; dudas rápidas y botón de WhatsApp
(número por evento); datos del comprador recordados con «No soy yo»; compartir evento y agregar al calendario; casilla de privacidad;
edad mínima por evento; link por promotor (`?r=nombre`) con ventas por promotor en Órdenes; barra fija con el total; vista previa
con nombre, fecha e imagen al compartir por WhatsApp (función de Cloudflare Pages).

- [ ] Al publicar: ejecutar `supabase/migraciones/004_mejoras_compra.sql` en Supabase ANTES de desplegar el API.
- [ ] En Cloudflare Pages (EventosQr.Web) agregar la variable `API_URL` (o dejar `VITE_API_URL` disponible también en tiempo de ejecución)
      para la vista previa al compartir. Probar después con el depurador de Facebook o mandando el link por WhatsApp.
- [ ] Textos legales: hoy la casilla de privacidad tiene una frase corta. Falta la página de términos y la política de privacidad completas.
- [ ] **Fases de venta visibles** (Fase 1 agotada, Fase 2 a la venta, Fase 3 próxima, con sus precios): queda para después por ser
      más delicado (cambia precios y cupos por fase, y cuándo se pasa de una a otra). Generalizaría la preventa actual (`precio_regular`).

### Ambiente de pruebas (staging) en el VPS de Hostinger

**Para qué:** probar `dev` en internet (con celulares reales, HTTPS y el link de venta) sin tocar producción.
**Cuándo:** después del evento. Producción queda como está (Render + Supabase + Cloudflare Pages).

| | Producción (como hoy) | Pruebas (nuevo) |
|---|---|---|
| Rama | `main` | `dev` |
| Web | Cloudflare Pages | Cloudflare Pages, preview de la rama `dev` (`VITE_API_URL` de «Preview» → API de pruebas) |
| API | Render | VPS · `api-dev.<dominio>` |
| Base | Supabase | VPS · Postgres + PostgREST + gateway (lo mismo de `dev/`, en Docker; no gasta otro proyecto de Supabase) |
| Correo | Gmail real | apagado o solo a una dirección de prueba |

- [ ] Datos que hacen falta: plan del VPS (CPU/RAM) y sistema operativo; dominio o subdominio para `api-dev`
      (sin dominio: túnel de Cloudflare); cómo se entra por SSH.
- [ ] Docker Compose con API + Postgres + PostgREST + gateway, con claves propias en un `.env` que vive solo en el VPS. Build con pnpm, nunca npm.
- [ ] Caddy delante con HTTPS automático (el escáner necesita HTTPS para la cámara).
- [ ] Despliegue de `dev`: script que trae la rama, reconstruye y reinicia; después, automático con GitHub Actions en cada push a `dev`.
- [ ] Seguridad: firewall (solo 22, 80, 443), SSH solo con llave, actualizaciones automáticas, copias diarias de la base de pruebas.
- [ ] Nunca datos reales de compradores en pruebas.
- [ ] Más adelante, evaluar mover producción al VPS: no se duerme como Render gratis y Hostinger tiene São Paulo (más cerca que Oregón),
      pero las copias, el monitoreo y las actualizaciones pasan a ser nuestros. Decidir con el staging ya andando un tiempo.

## Pendientes operativos (antes de vender entradas de JIWILIN)

- [ ] **Publicar la app de Google** (Google Auth Platform → Público → Publicar aplicación) y sacar un **refresh token nuevo**
      en https://developers.google.com/oauthplayground (scope `gmail.send`); cargarlo en Render como `GMAIL_REFRESH_TOKEN`.
      Si no, el token actual caduca el **27/10/2026** y los correos dejan de salir.
- [ ] **QR de pago nuevo sin vencimiento** (el actual vence el 26/10/2026 y cobra Bs 50 fijos, sirve para 1 entrada).
- [ ] Lugar y enlace de Google Maps del evento JIWILIN.
- [ ] Crear los usuarios de puerta (Staff) y asignarlos al evento.
- [ ] Probar el escáner con la cámara de un celular (único punto sin probar).
- [ ] Monitor externo de respaldo (UptimeRobot sobre `/health`); el API ya se visita a sí mismo cada 10 minutos.
- [ ] Rotar claves que quedaron escritas en el chat: clave `service_role` de Supabase, secreto del cliente OAuth de Google,
      contraseña de aplicación de Gmail antigua (`SMTP_PASS` en Render ya no se usa) y contraseñas de administrador.
- [ ] Decidir si se borra el evento de prueba «Prueba E2E Halloween» (hoy archivado).
- [ ] Revisar unos días antes que el proyecto de Supabase no se haya pausado (plan gratis: 7 días sin actividad).

## Ideas guardadas (sin fecha)

- Verificar correo/celular de verdad con un código (gasta el cupo de correos de Gmail; mejor con servicio de correo propio).
- Plan de pago de Render (7 USD/mes): no duerme el servidor y permite SMTP.
- Reducir latencia: mover API y base a una región más cercana a Bolivia (hoy Oregon, ~270 ms por viaje).
- Entrada con diseño propio (imagen o PDF) en vez de solo el QR en el correo.
