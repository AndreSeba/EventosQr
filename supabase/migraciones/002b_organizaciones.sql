-- MIGRACIÓN 002b (de 2): organizaciones (multi-cliente). Ejecutar DESPUÉS de la 002a.
-- Todo lo que ya existe queda dentro de la organización «Principal». La cuenta del dueño pasa a superadmin.
-- Es idempotente: se puede ejecutar de nuevo sin duplicar nada.
-- ANTES de ejecutarla en producción: copia de seguridad (Supabase → Database → Backups, o exportar las tablas).

begin;

create table if not exists organizaciones (
  id        uuid primary key default gen_random_uuid(),
  nombre    text not null check (char_length(nombre) between 2 and 100),
  slug      text not null unique check (slug ~ '^[a-z0-9-]{2,50}$'),
  activa    boolean not null default true,
  creada_en timestamptz not null default now()
);
alter table organizaciones enable row level security;

insert into organizaciones (nombre, slug) values ('Principal', 'principal') on conflict (slug) do nothing;

alter table usuarios add column if not exists org_id uuid references organizaciones (id) on delete restrict;
alter table eventos  add column if not exists org_id uuid references organizaciones (id) on delete restrict;

update eventos  set org_id = (select id from organizaciones where slug = 'principal') where org_id is null;
update usuarios set org_id = (select id from organizaciones where slug = 'principal') where org_id is null and rol <> 'superadmin';

-- El dueño del sistema: admin@eventosqr.local si existe; si no, el administrador más antiguo.
update usuarios
   set rol = 'superadmin', org_id = null
 where not exists (select 1 from usuarios where rol = 'superadmin')  -- solo la primera vez
   and id = coalesce((select id from usuarios where lower(email) = 'admin@eventosqr.local'),
                     (select id from usuarios where rol = 'admin' order by creado_en limit 1));

alter table eventos alter column org_id set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ck_usuarios_org') then
    alter table usuarios add constraint ck_usuarios_org check ((rol = 'superadmin') = (org_id is null));
  end if;
end $$;
create index if not exists eventos_org_idx  on eventos (org_id);
create index if not exists usuarios_org_idx on usuarios (org_id);

-- Funciones con la organización como defensa en profundidad (ver supabase/schema.sql)
drop function if exists aprobar_orden(uuid, uuid, text[]);
drop function if exists emitir_entradas(uuid, uuid, text, text, text[], uuid);

create or replace function aprobar_orden(p_id uuid, p_user uuid, p_tokens text[], p_org uuid default null)
returns table (id uuid, evento_id uuid, tipo_ticket_id uuid, nombre text, email text, cantidad int)
language plpgsql security definer set search_path = public as $$
declare v_o ordenes; v_t tipos_ticket; v_ocup int;
begin
  select * into v_o from ordenes where ordenes.id = p_id for update;
  if not found then raise exception 'ORDEN_NO_ENCONTRADA'; end if;
  if p_org is not null and (select e.org_id from eventos e where e.id = v_o.evento_id) is distinct from p_org then
    raise exception 'ORDEN_NO_ENCONTRADA';
  end if;
  if v_o.estado <> 'Pendiente' then raise exception 'ORDEN_YA_RESUELTA'; end if;
  if coalesce(array_length(p_tokens, 1), 0) <> v_o.cantidad then raise exception 'TOKENS_INVALIDOS'; end if;
  select * into v_t from tipos_ticket where tipos_ticket.id = v_o.tipo_ticket_id for update;
  if v_t.cupo is not null then
    v_ocup := (select count(*) from entradas e where e.tipo_ticket_id = v_t.id and e.estado <> 'anulada')
            + coalesce((select sum(o.cantidad) from ordenes o where o.tipo_ticket_id = v_t.id and o.estado = 'Pendiente' and o.id <> p_id), 0);
    if v_o.cantidad > v_t.cupo - v_ocup then raise exception 'SIN_CUPO:%', greatest(v_t.cupo - v_ocup, 0); end if;
  end if;
  update ordenes set estado = 'Aprobada', resuelta_en = now(), resuelta_por = p_user where ordenes.id = p_id;
  insert into entradas (evento_id, tipo_ticket_id, orden_id, nombre, email, token, creada_por)
    select v_o.evento_id, v_o.tipo_ticket_id, p_id, v_o.nombre, v_o.email, t, p_user from unnest(p_tokens) as t;
  return query select v_o.id, v_o.evento_id, v_o.tipo_ticket_id, v_o.nombre, v_o.email, v_o.cantidad;
end $$;

create or replace function emitir_entradas(p_evento uuid, p_tipo uuid, p_nombre text, p_email text, p_tokens text[], p_user uuid, p_org uuid default null)
returns uuid[] language plpgsql security definer set search_path = public as $$
declare v_t tipos_ticket; v_ocup int; v_ids uuid[];
begin
  if p_org is not null and (select e.org_id from eventos e where e.id = p_evento) is distinct from p_org then
    raise exception 'TIPO_INVALIDO';
  end if;
  select * into v_t from tipos_ticket where id = p_tipo and evento_id = p_evento and activo for update;
  if not found then raise exception 'TIPO_INVALIDO'; end if;
  if v_t.categoria = 'venta' then raise exception 'TIPO_ES_VENTA'; end if;
  if v_t.cupo is not null then
    v_ocup := (select count(*) from entradas where tipo_ticket_id = v_t.id and estado <> 'anulada');
    if array_length(p_tokens, 1) > v_t.cupo - v_ocup then raise exception 'SIN_CUPO:%', greatest(v_t.cupo - v_ocup, 0); end if;
  end if;
  with ins as (
    insert into entradas (evento_id, tipo_ticket_id, nombre, email, token, creada_por)
    select p_evento, v_t.id, p_nombre, p_email, t, p_user from unnest(p_tokens) as t returning id
  ) select array_agg(id) into v_ids from ins;
  return v_ids;
end $$;

revoke all on function aprobar_orden(uuid, uuid, text[], uuid) from public, anon, authenticated;
revoke all on function emitir_entradas(uuid, uuid, text, text, text[], uuid, uuid) from public, anon, authenticated;
grant execute on function aprobar_orden(uuid, uuid, text[], uuid) to service_role;
grant execute on function emitir_entradas(uuid, uuid, text, text, text[], uuid, uuid) to service_role;

commit;
