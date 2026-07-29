DROP INDEX IF EXISTS public.essay_chunks_embedding_idx;
DROP FUNCTION IF EXISTS public.match_essay_chunks(vector, int);
TRUNCATE public.essay_chunks;
ALTER TABLE public.essay_chunks ALTER COLUMN embedding TYPE vector(384);
CREATE INDEX essay_chunks_embedding_idx ON public.essay_chunks USING hnsw (embedding vector_cosine_ops);
CREATE OR REPLACE FUNCTION public.match_essay_chunks(
  query_embedding vector(384),
  match_count int DEFAULT 5
)
RETURNS TABLE (
  chunk_id UUID,
  essay_id UUID,
  title TEXT,
  source TEXT,
  chunk_index INT,
  content TEXT,
  similarity FLOAT
)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT c.id, c.essay_id, e.title, e.source, c.chunk_index, c.content,
         1 - (c.embedding <=> query_embedding)
  FROM public.essay_chunks c
  JOIN public.essays e ON e.id = c.essay_id
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;
GRANT EXECUTE ON FUNCTION public.match_essay_chunks(vector, int) TO anon, authenticated, service_role;