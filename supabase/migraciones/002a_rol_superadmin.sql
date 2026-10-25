-- MIGRACIÓN 002a (de 2): agrega el rol «superadmin». Ejecutar y CONFIRMAR antes de la 002b
-- (Postgres no permite usar un valor nuevo de un enum dentro de la misma transacción en que se crea).
alter type rol_usuario add value if not exists 'superadmin';
