-- A series no voucher uses yet may change its start number (the domain already refuses it once vouchers use the series). Its running
-- counter used to stay where it was, so raising the start (1 → 25) broke `series_next_ok` (next_value >= start_at) and the save failed with
-- an unexpected error. Now the counter moves with the start: to the new start if it had never been advanced by hand, otherwise to whichever
-- is higher (a forward jump someone made is kept).

create or replace function private.protect_series_start() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.vouchers where series_id = old.id) then
    perform private.raise_issue('IN_USE', 'Vouchers already use this series, so its start number cannot change');
  end if;
  new.next_value := case when old.next_value = old.start_at then new.start_at::bigint
                         else greatest(old.next_value, new.start_at::bigint) end;
  return new;
end
$$;
