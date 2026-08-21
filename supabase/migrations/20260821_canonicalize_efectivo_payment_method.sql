-- `efectivo` is the canonical payment method identifier used by the SaaS.
-- The accounting rail remains `cash` for reconciliation and analytics.

create or replace function public.manual_order_payment_method_id(p_method text)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  select case lower(trim(coalesce(p_method, '')))
    when 'cash' then 'efectivo'
    when 'tienda' then 'efectivo'
    when 'efectivo' then 'efectivo'
    when 'tarjeta' then 'card'
    when 'transferencia_bancaria' then 'bank_transfer'
    when 'online' then 'bank_transfer'
    else lower(trim(coalesce(p_method, '')))
  end
$function$;

create or replace function public.payment_method_key_v3(p_method text)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  select case lower(btrim(coalesce(p_method, '')))
    when 'cash' then 'efectivo'
    when 'tienda' then 'efectivo'
    when 'efectivo' then 'efectivo'
    when 'cash_usd' then 'cash_usd'
    when 'cash_ves' then 'cash_ves'
    when 'tarjeta' then 'card'
    when 'transferencia_bancaria' then 'bank_transfer'
    when 'online' then 'bank_transfer'
    else lower(btrim(coalesce(p_method, '')))
  end
$function$;

create or replace function public.payment_method_policy_v3(
  p_company_id uuid,
  p_method_id text,
  p_accounting_currency text
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_method text := public.payment_method_key_v3(p_method_id);
  v_row public.payment_methods%rowtype;
  v_rail text;
  v_evidence text;
  v_trigger text;
  v_currency text;
begin
  select * into v_row
  from public.payment_methods pm
  where pm.company_id = p_company_id
    and public.payment_method_key_v3(pm.method_name) = v_method
    and pm.is_active
  limit 1;

  v_rail := coalesce(v_row.rail, case
    when v_method in ('efectivo', 'cash_usd', 'cash_ves') then 'cash'
    when v_method in ('card', 'stripe', 'mercadopago') then 'card'
    else 'online'
  end);
  v_evidence := case
    when v_row.id is not null and v_row.requires_receipt then 'required'
    when v_method in ('pago_movil', 'zelle', 'paypal', 'bank_transfer') then 'required'
    else 'none'
  end;
  v_trigger := coalesce(v_row.settlement_trigger, case
    when v_rail = 'cash' then 'cash_confirmation'
    when v_method = 'card' then 'pos_confirmation'
    when v_method in ('stripe', 'mercadopago') then 'gateway_webhook'
    when v_evidence = 'required' then 'evidence_uploaded'
    else 'manual_verification'
  end);
  v_currency := upper(coalesce(
    nullif(v_row.settlement_currency, ''),
    case when v_method = 'pago_movil' then 'VES'
         when v_method = 'zelle' then 'USD'
         else p_accounting_currency end
  ));

  return jsonb_build_object(
    'id', v_method,
    'rail', v_rail,
    'evidencePolicy', v_evidence,
    'settlementTrigger', v_trigger,
    'settlementCurrency', v_currency,
    'allowMixedPayment', coalesce(v_row.allow_mixed_payment, true)
  );
end;
$function$;

update public.order_payment_lines
set method_id = 'efectivo'
where lower(btrim(method_id)) in ('cash', 'tienda');

update public.orders
set payment_method_specific = 'efectivo'
where lower(btrim(payment_method_specific)) in ('cash', 'tienda');
