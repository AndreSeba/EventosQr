# Ramas y publicación

| Rama | Para qué | ¿Se despliega solo? |
|---|---|---|
| `main` | **Producción.** Render la despliega automáticamente en cada push. | **Sí** |
| `qa` | Pruebas finales antes de producción. | No |
| `dev` | Integración del trabajo de desarrollo. | No |

Flujo: rama de la función → `dev` → `qa` → `main`. Las ramas de función se borran una vez publicadas. Nunca se empuja directo a `main` algo que no pasó por `dev` y `qa`.
Mientras haya un evento en curso, `main` no se toca salvo urgencias.

Las pruebas se hacen SIEMPRE contra el Postgres local (`dev/README.md`), nunca contra producción.

## Publicar «multi-cliente» (organizaciones) en producción

Está terminado y probado en desarrollo (unitarias 23/23, aislamiento 52/52, carga 30/30). Falta publicarlo. Hacerlo **después del evento de JIWILIN**, a una hora tranquila:

1. **Copia de seguridad** de la base de producción (Supabase → Database → Backups, o exportar las tablas).
2. Ensayar en `qa`: con la base de desarrollo cargada con datos parecidos a producción, aplicar las migraciones y correr `pnpm run test:aislamiento` y `pnpm run test:carga`.
3. En Supabase (SQL Editor) ejecutar `supabase/migraciones/002a_rol_superadmin.sql` y, **cuando termine**, `supabase/migraciones/002b_organizaciones.sql`.
   - Todo lo existente queda en la organización «Principal». La cuenta `admin@eventosqr.local` pasa a **superadmin**.
   - Si también se publica `mejoras-compra`: `003_precio_preventa.sql` (si no está aplicada) y `004_mejoras_compra.sql`. Son idempotentes.
     En Cloudflare Pages, la variable `API_URL` para la vista previa al compartir (ver `PENDIENTES.md`).
4. **Inmediatamente después**, mezclar `qa` → `main` en los dos repos (API y Web) para que Render despliegue. Entre el paso 3 y el despliegue (unos 2 minutos) el API viejo no deja entrar al superadmin ni crear usuarios o eventos; las compras públicas siguen funcionando.
5. Comprobar: entrar como superadmin, ver «Clientes», entrar como el administrador de «Principal» y ver solo lo suyo, y hacer una compra de prueba.
6. Plan de vuelta atrás: restaurar la copia del paso 1 y volver a desplegar el commit anterior de `main`.

Después de publicar, crear cada cliente nuevo desde **Clientes → Nuevo cliente** (el superadmin le entrega al administrador su correo y contraseña inicial).

## Reglas que protegen a los clientes entre sí

- Toda ruta que recibe un id de evento, orden, entrada, tipo o usuario comprueba que pertenezca a la organización de quien llama; si no, responde 404 como si no existiera.
- `tests/aislamiento/cobertura.ts` lista todas las rutas. Si agregas una ruta nueva y no la clasificas, `pnpm run test` falla.
- `pnpm run test:aislamiento` ataca cada ruta con la sesión de otra organización y comprueba que no cambió ni se filtró nada.
- Las funciones SQL `aprobar_orden` y `emitir_entradas` también reciben la organización y se niegan a operar con datos de otra.