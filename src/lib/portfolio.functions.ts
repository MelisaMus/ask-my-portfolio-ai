/**
 * RAG server functions for "Ask my Portfolio".
 *
 * Pipeline:
 *   1. ingestEssay: split essay into paragraph chunks -> embed each chunk
 *      via Lovable AI Gateway -> store text + vector in `essay_chunks`.
 *   2. askPortfolio: embed the user's question -> pgvector cosine similarity
 *      search (`match_essay_chunks`) -> pass top matches + question to an LLM
 *      -> return the model's answer plus the source chunks (title/source/excerpt).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1";
const EMBED_MODEL = "openai/text-embedding-3-small"; // 1536 dims -> matches vector(1536) column
const CHAT_MODEL = "google/gemini-3.6-flash";

async function embed(text: string): Promise<number[]> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("Missing LOVABLE_API_KEY");
  const res = await fetch(`${GATEWAY_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.data[0].embedding as number[];
}

/** Split an essay into paragraphs. Empty lines are the boundary. */
function chunkText(content: string): string[] {
  return content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

const IngestSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(20),
  source: z.string().optional().nullable(),
});

export const ingestEssay = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => IngestSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const title = data.title.trim();
    const content = data.content.trim();

    // Duplicate guard: reject if an essay with the same (case-insensitive) title
    // OR identical content already exists. Prevents accidental re-ingestion,
    // which would otherwise duplicate embeddings in the RAG index.
    const [byTitle, byContent] = await Promise.all([
      supabaseAdmin.from("essays").select("id, title").ilike("title", title).limit(1),
      supabaseAdmin.from("essays").select("id, title").eq("content", content).limit(1),
    ]);
    if (byTitle.error) throw new Error(byTitle.error.message);
    if (byContent.error) throw new Error(byContent.error.message);
    const dup = byTitle.data?.[0] ?? byContent.data?.[0];
    if (dup) {
      throw new Error(
        `Dieses Essay existiert bereits ("${dup.title}"). Ingest abgebrochen, keine doppelten Chunks erzeugt.`,
      );
    }

    // 1. Store the essay itself
    const { data: essay, error: essayErr } = await supabaseAdmin
      .from("essays")
      .insert({ title, content, source: data.source ?? null })
      .select("id")
      .single();
    if (essayErr || !essay) throw new Error(essayErr?.message ?? "Insert failed");

    // 2. Chunk + embed each paragraph, then persist with a foreign-key link
    const chunks = chunkText(content);
    const rows = [];
    for (let i = 0; i < chunks.length; i++) {
      const vector = await embed(chunks[i]);
      rows.push({
        essay_id: essay.id,
        chunk_index: i,
        content: chunks[i],
        embedding: vector as unknown as string,
      });
    }
    const { error: chunkErr } = await supabaseAdmin.from("essay_chunks").insert(rows);
    if (chunkErr) throw new Error(chunkErr.message);

    return { essay_id: essay.id, chunk_count: rows.length };
  });

const AskSchema = z.object({ question: z.string().min(2) });

/**
 * Retrieval-only variant: embed the question, return the top-5 chunks with
 * similarity scores. Useful for debugging the RAG index without invoking the LLM.
 */
export const searchPortfolio = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => AskSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const queryEmbedding = await embed(data.question);
    const { data: matches, error } = await supabaseAdmin.rpc("match_essay_chunks", {
      query_embedding: queryEmbedding as unknown as string,
      match_count: 5,
    });
    if (error) throw new Error(error.message);
    return {
      matches: (matches ?? []) as Array<{
        chunk_id: string;
        essay_id: string;
        title: string;
        source: string | null;
        chunk_index: number;
        content: string;
        similarity: number;
      }>,
    };
  });

export const askPortfolio = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => AskSchema.parse(data))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("Missing LOVABLE_API_KEY");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 1. Embed the question
    const queryEmbedding = await embed(data.question);

    // 2. Retrieve top-5 most similar chunks via pgvector cosine similarity
    const { data: matches, error } = await supabaseAdmin.rpc("match_essay_chunks", {
      query_embedding: queryEmbedding as unknown as string,
      match_count: 5,
    });
    if (error) throw new Error(error.message);

    const sources = (matches ?? []) as Array<{
      chunk_id: string;
      essay_id: string;
      title: string;
      source: string | null;
      chunk_index: number;
      content: string;
      similarity: number;
    }>;

    if (sources.length === 0) {
      return {
        answer: "In den vorhandenen Texten habe ich dazu nichts gefunden.",
        sources: [],
      };
    }

    // 3. Build a grounded prompt and ask the LLM to cite by [n]
    const context = sources
      .map((s, i) => `[${i + 1}] "${s.title}"${s.source ? ` (${s.source})` : ""}\n${s.content}`)
      .join("\n\n---\n\n");

    const systemPrompt =
      "Du beantwortest Fragen ausschließlich auf Grundlage der bereitgestellten Textausschnitte aus einer Essay-Sammlung. " +
      "Antworte auf Deutsch, präzise und in 2-5 Sätzen. Zitiere die verwendeten Quellen mit [1], [2] etc. " +
      "Wenn die Ausschnitte die Frage nicht beantworten, sage das ehrlich.";

    const chatRes = await fetch(`${GATEWAY_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Frage: ${data.question}\n\nTextausschnitte:\n\n${context}`,
          },
        ],
      }),
    });
    if (!chatRes.ok) throw new Error(`Chat failed: ${chatRes.status} ${await chatRes.text()}`);
    const chatJson = await chatRes.json();
    const answer: string = chatJson.choices?.[0]?.message?.content ?? "";

    return {
      answer,
      sources: sources.map((s, i) => ({
        ref: i + 1,
        essay_id: s.essay_id,
        title: s.title,
        source: s.source,
        excerpt: s.content.length > 240 ? s.content.slice(0, 240) + "…" : s.content,
        similarity: s.similarity,
      })),
    };
  });

