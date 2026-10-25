-- Precio de preventa: precio_regular es el precio normal que regirá cuando termine la preventa.
-- Si precio_regular > precio, la página de compra muestra el tipo como PREVENTA con el precio normal.
-- Idempotente; no cambia ningún dato existente.
alter table tipos_ticket add column if not exists precio_regular numeric(10,2)
  check (precio_regular is null or precio_regular >= 0);
