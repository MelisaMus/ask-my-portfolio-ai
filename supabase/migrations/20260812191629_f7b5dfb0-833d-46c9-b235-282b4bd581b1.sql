REVOKE ALL ON public.rate_limits FROM anon, authenticated;
GRANT ALL ON public.rate_limits TO service_role;
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rate_limits_no_client_access" ON public.rate_limits;
CREATE POLICY "rate_limits_no_client_access" ON public.rate_limits FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);