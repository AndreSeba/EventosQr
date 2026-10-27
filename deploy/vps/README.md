# EventosQr en el VPS de Hostinger (API + túnel de Cloudflare)

Proyecto Docker `eventosqr` (`docker-compose.yml` de esta carpeta). La base y las imágenes siguen en Supabase; solo se mueve la API.
Acceso público por un **túnel de Cloudflare**: la IP del servidor no se expone y no se usan los puertos 80/443 (el Caddy de Hermes no se toca).

## Pasos
1. Cloudflare → Zero Trust → Networks → Tunnels → crear túnel «tuqr» → copiar el **token** (va como `TUNNEL_TOKEN`, nunca al repo).
   Public hostname: `tuqr.<tu-dominio>` → servicio `http://api:4000`.
2. hPanel → VPS → Docker Manager → crear proyecto `eventosqr` con este compose y cargar las variables:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET` (**el mismo que usa hoy Render**, o todas las sesiones se cierran),
   `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `FRONTEND_URL`, `CORS_ORIGINS`, `SMTP_USER`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `TUNNEL_TOKEN`.
3. Probar `https://tuqr.<tu-dominio>/health` → `{"ok":true}`, un login y una compra de prueba (contra un evento de prueba, no el real).
4. `TRUST_PROXY`: detrás del túnel es 1. Verificar que el límite de intentos de login cuenta por persona y no por la IP del túnel
   (varios logins fallidos desde dos redes distintas no deben bloquearse entre sí).
5. Cambiar la URL de la API en la web (`VITE_API_URL`) y redesplegar. Dejar Render encendido unos días como vuelta atrás.

Actualizar el servidor: Docker Manager → proyecto → «Update» (vuelve a construir desde la rama `main`).