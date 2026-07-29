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

/** Map gateway HTTP errors to messages the UI can show directly. */
function gatewayError(status: number, body: string): Error {
  if (status === 429) return new Error("Zu viele Anfragen an die KI – bitte kurz warten und erneut versuchen.");
  if (status === 402 || status === 403)
    return new Error("KI-Guthaben/Limit des Workspace ist erreicht. Bitte unter Settings → Plans & credits anheben.");
  return new Error(`KI-Dienst-Fehler ${status}: ${body.slice(0, 200)}`);
}

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
  if (!res.ok) throw gatewayError(res.status, await res.text());
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

    // 1. Chunk + embed FIRST, before touching the DB. If any embedding fails
    //    (rate limit, credit exhaustion, provider 5xx), we abort *before*
    //    inserting the essay row — no orphan rows without chunks remain.
    const chunks = chunkText(content);
    if (chunks.length === 0) throw new Error("Kein Absatz erkannt.");
    const vectors: number[][] = [];
    for (const c of chunks) {
      vectors.push(await embed(c));
    }

    // 2. Insert essay + chunks only after every embedding succeeded.
    const { data: essay, error: essayErr } = await supabaseAdmin
      .from("essays")
      .insert({ title, content, source: data.source ?? null })
      .select("id")
      .single();
    if (essayErr || !essay) throw new Error(essayErr?.message ?? "Insert failed");

    const rows = chunks.map((text, i) => ({
      essay_id: essay.id,
      chunk_index: i,
      content: text,
      embedding: vectors[i] as unknown as string,
    }));
    const { error: chunkErr } = await supabaseAdmin.from("essay_chunks").insert(rows);
    if (chunkErr) {
      // Roll back the essay row so a chunk-insert failure doesn't leave an orphan.
      await supabaseAdmin.from("essays").delete().eq("id", essay.id);
      throw new Error(chunkErr.message);
    }

    return { essay_id: essay.id, chunk_count: rows.length };
  });

const AskSchema = z.object({ question: z.string().min(2) });

/** Default cosine-similarity cutoff for retrieval (0 = alles, 1 = identisch). */
const DEFAULT_SIMILARITY_THRESHOLD = 0.3;

const SearchSchema = z.object({
  question: z.string().min(2),
  threshold: z.number().min(0).max(1).optional(),
});

type MatchRow = {
  chunk_id: string;
  essay_id: string;
  title: string;
  source: string | null;
  chunk_index: number;
  content: string;
  similarity: number;
};

/**
 * Retrieval-only variant: embed the question, return the top-5 chunks with
 * similarity scores. Useful for debugging the RAG index without invoking the LLM.
 * Treffer unterhalb des konfigurierbaren Thresholds werden herausgefiltert.
 */
export const searchPortfolio = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => SearchSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const threshold = data.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    const queryEmbedding = await embed(data.question);
    const { data: matches, error } = await supabaseAdmin.rpc("match_essay_chunks", {
      query_embedding: queryEmbedding as unknown as string,
      match_count: 5,
    });
    if (error) throw new Error(error.message);
    const all = (matches ?? []) as MatchRow[];
    const filtered = all.filter((m) => m.similarity >= threshold);

    // Debug-Metadaten: Gesamtzahl der Absätze je Essay, damit die UI
    // "Absatz 3 von 12" statt nur "Absatz 3" anzeigen kann.
    const essayIds = [...new Set(filtered.map((m) => m.essay_id))];
    const totals: Record<string, number> = {};
    await Promise.all(
      essayIds.map(async (id) => {
        const { count } = await supabaseAdmin
          .from("essay_chunks")
          .select("id", { count: "exact", head: true })
          .eq("essay_id", id);
        totals[id] = count ?? 0;
      }),
    );

    return {
      threshold,
      retrieved: all.length,
      matches: filtered.map((m) => ({
        ...m,
        chunk_total: totals[m.essay_id] ?? 0,
        char_count: m.content.length,
        word_count: m.content.trim().split(/\s+/).filter(Boolean).length,
      })),
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

    const allMatches = (matches ?? []) as Array<{
      chunk_id: string;
      essay_id: string;
      title: string;
      source: string | null;
      chunk_index: number;
      content: string;
      similarity: number;
    }>;

    // Keep the 3-5 best chunks: everything above the similarity threshold,
    // but always at least the top 3 so the LLM never runs without context.
    const relevant = allMatches.filter((m) => m.similarity >= DEFAULT_SIMILARITY_THRESHOLD);
    const sources = (relevant.length >= 3 ? relevant : allMatches.slice(0, 3)).slice(0, 5);


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
    if (!chatRes.ok) throw gatewayError(chatRes.status, await chatRes.text());
    const chatJson = await chatRes.json();
    const answer: string = chatJson.choices?.[0]?.message?.content ?? "";

    return {
      answer,
      sources: sources.map((s, i) => ({
        ref: i + 1,
        essay_id: s.essay_id,
        title: s.title,
        source: s.source,
        // Absatz-Referenz (0-basiert im Index -> 1-basiert für die Anzeige)
        chunk_index: s.chunk_index,
        excerpt: s.content.length > 240 ? s.content.slice(0, 240) + "…" : s.content,
        similarity: s.similarity,
      })),
    };
  });

