# Entorno de desarrollo (Postgres local)

Sirve para probar TODO sin tocar producción (Supabase real). Corre en tu PC: Postgres 17 + PostgREST + un gateway que imita
las rutas de Supabase que usa el API. El API no cambia: solo se apunta `SUPABASE_URL` a la base local.

```
API (:4000)  ──►  gateway (:54321) ──► /rest/v1    ──► PostgREST (:3001) ──► Postgres 17 (:54329)
                                    └─► /storage/v1 ──► carpeta dev/storage  (comprobantes e imágenes)
```

## Una sola vez: descargar los programas (no se suben a git)

Se guardan en `dev/pg` y `dev/postgrest`. Las carpetas `dev/descargas`, `dev/pg`, `dev/postgrest`, `dev/datos` y `dev/storage` están en `.gitignore`.

| Programa | Versión | Tamaño | Fuente |
|---|---|---|---|
| PostgreSQL (zip portable, no instala nada) | 17.11 (la misma familia que usa Supabase) | 325 MB | https://get.enterprisedb.com/postgresql/postgresql-17.11-1-windows-x64-binaries.zip |
| PostgREST | 16.5 | 14 MB | https://github.com/PostgREST/postgrest/releases/download/v16.5/postgrest-v16.5-windows-x86-64.zip |

Descomprimir el primero en `dev/pg` (queda `dev/pg/pgsql/bin`) y el segundo en `dev/postgrest` (queda `dev/postgrest/postgrest.exe`).
PostgREST necesita las DLL de Postgres: el script ya agrega `dev/pg/pgsql/bin` al PATH.

## Uso diario

```bash
npm run dev:db          # levanta Postgres + PostgREST + gateway (la primera vez crea la base y aplica supabase/schema.sql)
npm run dev             # API en http://localhost:4000  (usa .env de DESARROLLO)
npm run test             # pruebas unitarias
npm run test:carga      # simulación de carga y consistencia por el API (150 compradores, aprobaciones, puerta, permisos)
npm run dev:db:stop     # apaga todo; los datos de desarrollo se conservan en dev/datos
```

El front local (`EventosQr.Web`, `npm run dev`) usa `VITE_API_URL=http://127.0.0.1:4000`, o sea esta misma base.

## Reglas de seguridad

- El `.env` de trabajo apunta a esta base local (usuario `admin@dev.local`). **Las claves de producción no están ahí**: viven en Render.
  Si hace falta una copia local, va en `.env.produccion`, que NUNCA se carga sola.
- `npm run test:carga` **se niega a correr** si `SUPABASE_URL` no es local (`127.0.0.1` / `localhost`).
- En desarrollo no hay `SMTP_*` ni `GMAIL_*`: no sale ningún correo.
- El esquema se aplica desde `supabase/schema.sql`, el mismo archivo que se usa en producción. Si cambias el esquema, cámbialo ahí y
  recrea la base local (`npm run dev:db:stop`, borrar `dev/datos`, `npm run dev:db`).

## Qué imita y qué no

- **Postgres y RLS/permisos**: reales (PostgreSQL 17, mismos roles `anon`/`authenticated`/`service_role`, mismas funciones SQL).
- **API REST**: PostgREST real, la misma tecnología que Supabase.
- **Storage**: lo reimplementa `dev/gateway.mjs` solo con lo que usa el API (subir, borrar, firmar, bajar). No es un Supabase Storage completo.
- **Auth de Supabase**: no se usa (el API tiene sus propios usuarios y sesiones).
- **Correo**: no se prueba aquí; el envío real (API de Gmail) solo se puede verificar con credenciales reales.
