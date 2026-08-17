-- Primary delivery address on registered clients (last used replaces previous).
-- Apply on the Supabase instance used by the app.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS default_delivery_address jsonb;

ALTER TABLE public.clients
  DROP CONSTRAINT IF EXISTS clients_default_delivery_address_object;

ALTER TABLE public.clients
  ADD CONSTRAINT clients_default_delivery_address_object
  CHECK (
    default_delivery_address IS NULL
    OR jsonb_typeof(default_delivery_address) = 'object'
  );

COMMENT ON COLUMN public.clients.default_delivery_address IS
  'Last delivery address for the client: { address: text, reference: text }. Zone/km/fee are not stored.';

NOTIFY pgrst, 'reload schema';
