-- Permisos que Supabase otorga solo: el API usa service_role (ignora RLS, igual que en producción).
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
notify pgrst, 'reload schema';
