-- Titular por entrada (cédula y acompañantes). Idempotente; no cambia ningún dato existente salvo rellenar numero_en_orden.
--  ordenes.titulares   : lo que el comprador escribió al comprar, un elemento por entrada: [{"nombre": "...", "ci": "..."}, ...] (opcional)
--  entradas.ci         : cédula del titular (opcional)
--  numero_en_orden     : posición de la entrada dentro de su orden (1..N); el escáner muestra «Entrada 2 de 3»
--  titular_definido    : false = la entrada lleva el nombre del comprador porque nadie escribió el del acompañante
--  transferencias      : cuántas veces se transfirió (cada una emite un QR nuevo e invalida el anterior)
--  entrada_cambios     : quién cambió el titular de una entrada, cuándo y qué había antes
alter table ordenes  add column if not exists titulares jsonb;
alter table entradas add column if not exists ci text
  check (ci is null or ci ~ '^[A-Za-z0-9][A-Za-z0-9 .-]{2,18}[A-Za-z0-9]$');
alter table entradas add column if not exists numero_en_orden int;
alter table entradas add column if not exists titular_definido boolean not null default true;
alter table entradas add column if not exists transferencias int not null default 0;

create table if not exists entrada_cambios (
  id              uuid primary key default gen_random_uuid(),
  entrada_id      uuid not null references entradas (id) on delete restrict,
  tipo            text not null check (tipo in ('titular', 'transferencia')),
  por             text not null,                 -- «comprador» o el nombre del usuario del equipo
  nombre_anterior text,
  ci_anterior     text,
  nombre_nuevo    text,
  ci_nuevo        text,
  creado_en       timestamptz not null default now()
);
create index if not exists entrada_cambios_entrada_idx on entrada_cambios (entrada_id);
alter table entrada_cambios enable row level security;

-- Al insertarse una entrada de una orden: le asigna su número dentro de la orden y aplica el titular que el comprador indicó.
-- NUNCA lanza error (un dato mal escrito no puede impedir que se apruebe una orden): lo inválido se ignora.
create or replace function entradas_titular() returns trigger language plpgsql as $$
declare v_n int; v_t jsonb; v_nom text; v_ci text;
begin
  if new.orden_id is null then
    new.titular_definido := true;
    return new;
  end if;
  select coalesce(max(numero_en_orden), 0) + 1 into v_n from entradas where orden_id = new.orden_id;
  new.numero_en_orden := v_n;
  new.titular_definido := (v_n = 1);
  select titulares -> (v_n - 1) into v_t from ordenes where id = new.orden_id;
  if v_t is not null and jsonb_typeof(v_t) = 'object' then
    v_nom := nullif(btrim(v_t ->> 'nombre'), '');
    if v_n > 1 and v_nom is not null and char_length(v_nom) between 2 and 100 then
      new.nombre := v_nom;
      new.titular_definido := true;
    end if;
    v_ci := nullif(btrim(v_t ->> 'ci'), '');
    if v_ci is not null and v_ci ~ '^[A-Za-z0-9][A-Za-z0-9 .-]{2,18}[A-Za-z0-9]$' then
      new.ci := v_ci;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists entradas_titular_bi on entradas;
create trigger entradas_titular_bi before insert on entradas for each row execute function entradas_titular();

-- Entradas que ya existen: se numeran dentro de su orden; las que no son la primera quedan como «acompañante» (sin nombre propio).
update entradas e set numero_en_orden = r.n, titular_definido = (r.n = 1)
  from (select id, row_number() over (partition by orden_id order by creada_en, id) as n from entradas where orden_id is not null) r
 where e.id = r.id and e.numero_en_orden is null;