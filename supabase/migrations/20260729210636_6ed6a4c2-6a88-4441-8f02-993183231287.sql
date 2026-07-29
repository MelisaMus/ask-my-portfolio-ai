CREATE TABLE public.rate_limits (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  bucket text NOT NULL,
  client_hash text NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, client_hash, window_start)
);

-- Nur serverseitiger Zugriff: kein anon/authenticated-Grant.
GRANT ALL ON public.rate_limits TO service_role;

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

CREATE INDEX rate_limits_window_idx ON public.rate_limits (window_start);

-- Atomarer Zähler: legt das Fenster an oder erhöht es und liefert den Stand zurück.
CREATE OR REPLACE FUNCTION public.hit_rate_limit(
  _bucket text,
  _client_hash text,
  _window_seconds integer,
  _max_requests integer
)
RETURNS TABLE(allowed boolean, current_count integer, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _window_start timestamptz;
  _count integer;
BEGIN
  -- Feste Zeitfenster (tumbling window) über Epoch-Division.
  _window_start := to_timestamp(floor(extract(epoch from now()) / _window_seconds) * _window_seconds);

  INSERT INTO public.rate_limits (bucket, client_hash, window_start, request_count)
  VALUES (_bucket, _client_hash, _window_start, 1)
  ON CONFLICT (bucket, client_hash, window_start)
  DO UPDATE SET request_count = public.rate_limits.request_count + 1, updated_at = now()
  RETURNING request_count INTO _count;

  -- Alte Fenster gelegentlich aufräumen (ca. 1 % der Aufrufe).
  IF random() < 0.01 THEN
    DELETE FROM public.rate_limits WHERE window_start < now() - interval '1 day';
  END IF;

  RETURN QUERY SELECT
    _count <= _max_requests,
    _count,
    GREATEST(0, ceil(extract(epoch from (_window_start + make_interval(secs => _window_seconds)) - now()))::integer);
END;
$$;

REVOKE ALL ON FUNCTION public.hit_rate_limit(text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hit_rate_limit(text, text, integer, integer) TO service_role;