
CREATE EXTENSION IF NOT EXISTS vector;

-- Main essays table: one row per essay
CREATE TABLE public.essays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.essays TO anon, authenticated;
GRANT ALL ON public.essays TO service_role;
ALTER TABLE public.essays ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Essays are public readable" ON public.essays FOR SELECT USING (true);

-- Chunk table: paragraph-level chunks with embeddings for RAG retrieval
CREATE TABLE public.essay_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  essay_id UUID NOT NULL REFERENCES public.essays(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.essay_chunks TO anon, authenticated;
GRANT ALL ON public.essay_chunks TO service_role;
ALTER TABLE public.essay_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Chunks are public readable" ON public.essay_chunks FOR SELECT USING (true);

CREATE INDEX essay_chunks_embedding_idx
  ON public.essay_chunks USING hnsw (embedding vector_cosine_ops);

-- Similarity search function: returns top-N chunks by cosine similarity
CREATE OR REPLACE FUNCTION public.match_essay_chunks(
  query_embedding vector(1536),
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
  SELECT
    c.id AS chunk_id,
    c.essay_id,
    e.title,
    e.source,
    c.chunk_index,
    c.content,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.essay_chunks c
  JOIN public.essays e ON e.id = c.essay_id
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION public.match_essay_chunks(vector, int) TO anon, authenticated, service_role;
