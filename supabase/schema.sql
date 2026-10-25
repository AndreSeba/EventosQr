-- Esquema de EventosQr para Supabase. SQL Editor > New query > pegar todo > Run.
create extension if not exists pgcrypto;

create type rol_usuario as enum ('admin', 'rrpp', 'staff');
create type estado_orden as enum ('Pendiente', 'Aprobada', 'Rechazada');

create table usuarios (
  id            uuid primary key default gen_random_uuid(),
  email         text not null check (char_length(email) <= 120),
  nombre        text not null check (char_length(nombre) between 2 and 100),
  password_hash text not null,
  rol           rol_usuario not null,
  activo        boolean not null default true,
  creado_en     timestamptz not null default now()
);
create unique index usuarios_email_uq on usuarios (lower(email));

create table eventos (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique check (slug ~ '^[a-z0-9-]{3,70}$'),
  nombre        text not null check (char_length(nombre) between 2 and 120),
  descripcion   text check (char_length(descripcion) <= 1000),
  lugar         text check (char_length(lugar) <= 150),
  direccion_url text check (char_length(direccion_url) <= 500),
  fecha_inicio  timestamptz not null,
  moneda        text not null default 'BOB' check (moneda ~ '^[A-Z]{3}$'),
  imagen_path   text,
  qr_pago_path  text,
  archivado     boolean not null default false,
  creado_en     timestamptz not null default now()
);

create table tipos_ticket (
  id        uuid primary key default gen_random_uuid(),
  evento_id uuid not null references eventos (id) on delete restrict,
  nombre    text not null check (char_length(nombre) between 2 and 60),
  precio    numeric(10,2) not null default 0 check (precio >= 0),
  precio_regular numeric(10,2) check (precio_regular is null or precio_regular >= 0), -- precio normal tras la preventa
  cupo      int check (cupo is null or cupo > 0),   -- null = sin límite
  -- venta: se compra en la landing. invitacion / vip: solo se emiten a mano (equipo).
  categoria text not null default 'venta' check (categoria in ('venta', 'invitacion', 'vip')),
  activo    boolean not null default true,
  creado_en timestamptz not null default now(),
  unique (evento_id, nombre)
);

-- Quién del equipo (rrpp / staff) puede trabajar con cada evento. Admin ve todos.
create table evento_equipo (
  evento_id  uuid not null references eventos (id) on delete cascade,
  usuario_id uuid not null references usuarios (id) on delete cascade,
  primary key (evento_id, usuario_id)
);

create table ordenes (
  id                 uuid primary key default gen_random_uuid(),
  numero             bigint generated always as identity,
  evento_id          uuid not null references eventos (id) on delete restrict,
  tipo_ticket_id     uuid not null references tipos_ticket (id) on delete restrict,
  nombre             text not null check (char_length(nombre) between 2 and 100),
  telefono           text not null check (char_length(telefono) between 7 and 25),
  email              text not null check (char_length(email) <= 120 and email ~* '^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$'),
  cantidad           int  not null default 1 check (cantidad between 1 and 10),
  monto              numeric(10,2) not null check (monto >= 0),
  comprobante_path   text not null,
  comprobante_sha256 text not null,
  estado             estado_orden not null default 'Pendiente',
  motivo_rechazo     text,
  resuelta_por       uuid references usuarios (id),
  correo_enviado_en  timestamptz,
  correo_error       text,
  creada_en          timestamptz not null default now(),
  resuelta_en        timestamptz,
  constraint ck_motivo check (estado <> 'Rechazada' or char_length(coalesce(motivo_rechazo, '')) >= 3)
);
-- Duplicados obvios: un correo por evento y un comprobante (por hash) en una sola orden viva.
create unique index ordenes_email_evento_activa
  on ordenes (evento_id, lower(email)) where estado in ('Pendiente', 'Aprobada');
create unique index ordenes_comprobante_activo
  on ordenes (comprobante_sha256) where estado in ('Pendiente', 'Aprobada');
create index ordenes_evento_idx on ordenes (evento_id, estado, creada_en desc);

create table entradas (
  id             uuid primary key default gen_random_uuid(),
  evento_id      uuid not null references eventos (id) on delete restrict,
  tipo_ticket_id uuid not null references tipos_ticket (id) on delete restrict,
  orden_id       uuid references ordenes (id) on delete restrict,   -- null = invitación manual
  nombre         text not null check (char_length(nombre) between 2 and 100),
  email          text check (char_length(email) <= 120),
  token          text not null unique check (char_length(token) >= 32),   -- 192 bits base64url
  estado         text not null default 'valida' check (estado in ('valida', 'usada', 'anulada')),
  usada_en       timestamptz,
  usada_por      uuid references usuarios (id),
  anulada_en     timestamptz,
  anulada_motivo text,
  creada_por     uuid references usuarios (id),
  creada_en      timestamptz not null default now(),
  constraint ck_usada_coherente check ((estado = 'usada') = (usada_en is not null)),
  constraint ck_anulada_coherente check ((estado = 'anulada') = (anulada_en is not null))
);
create index entradas_evento_idx on entradas (evento_id, estado);
create index entradas_orden_idx  on entradas (orden_id);

-- La API usa la clave service_role (ignora RLS). RLS sin políticas bloquea la clave pública.
alter table usuarios      enable row level security;
alter table eventos       enable row level security;
alter table tipos_ticket  enable row level security;
alter table evento_equipo enable row level security;
alter table ordenes       enable row level security;
alter table entradas      enable row level security;

-- ============================================================================================
-- Funciones atómicas de cupo. Cada una bloquea la fila del tipo de ticket (FOR UPDATE) y valida
-- + escribe en UNA transacción. Sin esto, "contar y luego insertar" deja pasar de más cuando
-- muchas personas compran a la vez (comprobado con 150 compradores simultáneos).
-- ============================================================================================
create or replace function crear_orden(p_slug text, p_tipo uuid, p_nombre text, p_telefono text, p_email text,
  p_cantidad int, p_path text, p_sha text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_ev eventos; v_t tipos_ticket; v_ocup int; v_num bigint;
begin
  select * into v_ev from eventos where slug = p_slug;
  if not found or v_ev.archivado then raise exception 'EVENTO_NO_ENCONTRADO'; end if;
  select * into v_t from tipos_ticket
    where id = p_tipo and evento_id = v_ev.id and activo and categoria = 'venta' for update;
  if not found then raise exception 'TIPO_INVALIDO'; end if;
  if v_t.cupo is not null then
    v_ocup := (select count(*) from entradas where tipo_ticket_id = v_t.id and estado <> 'anulada')
            + coalesce((select sum(cantidad) from ordenes where tipo_ticket_id = v_t.id and estado = 'Pendiente'), 0);
    if p_cantidad > v_t.cupo - v_ocup then raise exception 'SIN_CUPO:%', greatest(v_t.cupo - v_ocup, 0); end if;
  end if;
  insert into ordenes (evento_id, tipo_ticket_id, nombre, telefono, email, cantidad, monto, comprobante_path, comprobante_sha256)
  values (v_ev.id, v_t.id, p_nombre, p_telefono, p_email, p_cantidad, v_t.precio * p_cantidad, p_path, p_sha)
  returning numero into v_num;
  return v_num;
end $$;

create or replace function aprobar_orden(p_id uuid, p_user uuid, p_tokens text[])
returns table (id uuid, evento_id uuid, tipo_ticket_id uuid, nombre text, email text, cantidad int)
language plpgsql security definer set search_path = public as $$
declare v_o ordenes; v_t tipos_ticket; v_ocup int;
begin
  select * into v_o from ordenes where ordenes.id = p_id for update;
  if not found then raise exception 'ORDEN_NO_ENCONTRADA'; end if;
  if v_o.estado <> 'Pendiente' then raise exception 'ORDEN_YA_RESUELTA'; end if;
  if coalesce(array_length(p_tokens, 1), 0) <> v_o.cantidad then raise exception 'TOKENS_INVALIDOS'; end if;
  select * into v_t from tipos_ticket where tipos_ticket.id = v_o.tipo_ticket_id for update;
  if v_t.cupo is not null then
    -- esta orden ya cuenta como reservada mientras está pendiente: se excluye del conteo
    v_ocup := (select count(*) from entradas e where e.tipo_ticket_id = v_t.id and e.estado <> 'anulada')
            + coalesce((select sum(o.cantidad) from ordenes o where o.tipo_ticket_id = v_t.id and o.estado = 'Pendiente' and o.id <> p_id), 0);
    if v_o.cantidad > v_t.cupo - v_ocup then raise exception 'SIN_CUPO:%', greatest(v_t.cupo - v_ocup, 0); end if;
  end if;
  update ordenes set estado = 'Aprobada', resuelta_en = now(), resuelta_por = p_user where ordenes.id = p_id;
  insert into entradas (evento_id, tipo_ticket_id, orden_id, nombre, email, token, creada_por)
    select v_o.evento_id, v_o.tipo_ticket_id, p_id, v_o.nombre, v_o.email, t, p_user from unnest(p_tokens) as t;
  return query select v_o.id, v_o.evento_id, v_o.tipo_ticket_id, v_o.nombre, v_o.email, v_o.cantidad;
end $$;

create or replace function emitir_entradas(p_evento uuid, p_tipo uuid, p_nombre text, p_email text, p_tokens text[], p_user uuid)
returns uuid[] language plpgsql security definer set search_path = public as $$
declare v_t tipos_ticket; v_ocup int; v_ids uuid[];
begin
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

-- Escriben datos: solo la API (service_role) puede llamarlas, nunca la clave pública.
revoke all on function crear_orden(text, uuid, text, text, text, int, text, text) from public, anon, authenticated;
revoke all on function aprobar_orden(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function emitir_entradas(uuid, uuid, text, text, text[], uuid) from public, anon, authenticated;
grant execute on function crear_orden(text, uuid, text, text, text, int, text, text) to service_role;
grant execute on function aprobar_orden(uuid, uuid, text[]) to service_role;
grant execute on function emitir_entradas(uuid, uuid, text, text, text[], uuid) to service_role;

-- Resumen del Panel en UNA consulta (antes eran ~15 viajes seguidos a la base).
create or replace function resumen_evento(p_evento uuid) returns jsonb
language sql stable security definer set search_path = public as $$
select jsonb_build_object(
  'ventas',            coalesce((select sum(monto) from ordenes where evento_id = p_evento and estado = 'Aprobada'), 0),
  'ordenesAprobadas',  (select count(*) from ordenes  where evento_id = p_evento and estado = 'Aprobada'),
  'ordenesPendientes', (select count(*) from ordenes  where evento_id = p_evento and estado = 'Pendiente'),
  'ticketsEmitidos',   (select count(*) from entradas where evento_id = p_evento and estado <> 'anulada'),
  'ticketsUsados',     (select count(*) from entradas where evento_id = p_evento and estado = 'usada'),
  'ticketsAnulados',   (select count(*) from entradas where evento_id = p_evento and estado = 'anulada'),
  'porTipo', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'nombre', t.nombre, 'cupo', t.cupo,
      'emitidas', (select count(*) from entradas e where e.tipo_ticket_id = t.id and e.estado <> 'anulada'),
      'disponibles', case when t.cupo is null then null else greatest(t.cupo
          - (select count(*) from entradas e where e.tipo_ticket_id = t.id and e.estado <> 'anulada')
          - coalesce((select sum(o.cantidad) from ordenes o where o.tipo_ticket_id = t.id and o.estado = 'Pendiente'), 0), 0) end
    ) order by t.creado_en)
    from tipos_ticket t where t.evento_id = p_evento), '[]'::jsonb)
) $$;
revoke all on function resumen_evento(uuid) from public, anon, authenticated;
grant execute on function resumen_evento(uuid) to service_role;
-- Buckets: comprobantes PRIVADO; publico (imagen del evento y QR de pago) con lectura pública.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('comprobantes', 'comprobantes', false, 4194304, array['image/jpeg','image/png','image/webp','application/pdf']),
  ('publico',      'publico',      true,  4194304, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
