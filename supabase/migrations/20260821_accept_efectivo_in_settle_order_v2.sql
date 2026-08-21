-- Keep `efectivo` as the configurable method identifier while its accounting
-- rail remains `cash` in the manual-order settlement flow.
do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.settle_order_v2(text,uuid,jsonb)'::regprocedure
  ) into v_definition;

  v_definition := replace(
    v_definition,
    $$and v_method_id not in ('cash','card','bank_transfer')$$,
    $$and v_method_id not in ('efectivo','cash','card','bank_transfer')$$
  );

  v_definition := replace(
    v_definition,
    $$v_method_id in ('cash','cash_usd','cash_ves') then 'cash'$$,
    $$v_method_id in ('efectivo','cash','cash_usd','cash_ves') then 'cash'$$
  );

  if position(
    $$v_method_id in ('efectivo','cash','cash_usd','cash_ves') then 'cash'$$
    in v_definition
  ) = 0 then
    raise exception 'Could not patch settle_order_v2 cash-rail mapping';
  end if;

  execute v_definition;
end;
$migration$;
