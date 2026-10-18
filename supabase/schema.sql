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

-- Buckets: comprobantes PRIVADO; publico (imagen del evento y QR de pago) con lectura pública.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('comprobantes', 'comprobantes', false, 4194304, array['image/jpeg','image/png','image/webp','application/pdf']),
  ('publico',      'publico',      true,  4194304, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
