/**
 * RAG server functions for "Ask my Portfolio".
 *
 * Pipeline:
 *   1. Client (Browser): Essay in Absätze chunken und für jeden Absatz mit dem
 *      lokalen MiniLM-Modell (`Xenova/all-MiniLM-L6-v2`, 384 Dimensionen) ein
 *      Embedding erzeugen – siehe `src/lib/local-embeddings.ts`.
 *   2. ingestEssay: nimmt Text + fertige Vektoren entgegen und speichert
 *      beides in `essays` / `essay_chunks`.
 *   3. searchPortfolio / askPortfolio: bekommen das (ebenfalls lokal erzeugte)
 *      Frage-Embedding, machen die pgvector-Cosine-Similarity-Suche
 *      (`match_essay_chunks`) und – bei askPortfolio – die LLM-Antwort.
 *
 * Embeddings kosten damit kein AI-Gateway-Guthaben; nur die LLM-Antwort
 * läuft weiterhin über das Gateway.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1";
const CHAT_MODEL = "google/gemini-3.6-flash";
/** Eigener OpenAI-Key (Secret) – wird bevorzugt, umgeht das Workspace-Limit. */
const OPENAI_URL = "https://api.openai.com/v1";
const OPENAI_MODEL = "gpt-4o-mini";
/** Dimension des lokalen MiniLM-Modells – muss zu vector(384) passen. */
const EMBEDDING_DIM = 384;

/** Map gateway HTTP errors to messages the UI can show directly. */
function gatewayError(status: number, body: string): Error {
  if (status === 429) return new Error("Zu viele Anfragen an die KI – bitte kurz warten und erneut versuchen.");
  if (status === 401) return new Error("Der hinterlegte OpenAI-API-Key ist ungültig.");
  if (status === 402 || status === 403)
    return new Error("KI-Guthaben/Limit ist erreicht. Bitte Guthaben aufladen.");
  return new Error(`KI-Dienst-Fehler ${status}: ${body.slice(0, 200)}`);
}


const VectorSchema = z.array(z.number()).length(EMBEDDING_DIM);

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
  /** Ein lokal erzeugter Vektor pro Absatz, in derselben Reihenfolge. */
  embeddings: z.array(VectorSchema).min(1),
});

export const ingestEssay = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => IngestSchema.parse(data))
  .handler(async ({ data }) => {
    // Schreibzugriff nur mit freigeschalteter Admin-Session.
    const { requireAdmin } = await import("./admin-gate.server");
    await requireAdmin();
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

    // Chunking serverseitig wiederholen und gegen die Vektoranzahl prüfen,
    // damit Text und Embedding garantiert zusammenpassen.
    const chunks = chunkText(content);
    if (chunks.length === 0) throw new Error("Kein Absatz erkannt.");
    if (chunks.length !== data.embeddings.length) {
      throw new Error(
        `Anzahl Absätze (${chunks.length}) und Embeddings (${data.embeddings.length}) stimmen nicht überein.`,
      );
    }

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
      embedding: JSON.stringify(data.embeddings[i]) as unknown as string,
    }));
    const { error: chunkErr } = await supabaseAdmin.from("essay_chunks").insert(rows);
    if (chunkErr) {
      // Roll back the essay row so a chunk-insert failure doesn't leave an orphan.
      await supabaseAdmin.from("essays").delete().eq("id", essay.id);
      throw new Error(chunkErr.message);
    }

    return { essay_id: essay.id, chunk_count: rows.length };
  });

const UpdateSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  content: z.string().min(20),
  source: z.string().optional().nullable(),
  /** Neu berechnete Vektoren – ein Vektor pro Absatz des NEUEN Textes. */
  embeddings: z.array(VectorSchema).min(1),
});

/**
 * Essay bearbeiten. Der RAG-Index wird dabei immer neu aufgebaut:
 * alte Chunks werden gelöscht und durch die neuen Absätze + Embeddings ersetzt.
 */
export const updateEssay = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => UpdateSchema.parse(data))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./admin-gate.server");
    await requireAdmin();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");


    const title = data.title.trim();
    const content = data.content.trim();

    // Duplikat-Check gegen ANDERE Essays (das eigene darf gleich bleiben).
    const [byTitle, byContent] = await Promise.all([
      supabaseAdmin.from("essays").select("id, title").ilike("title", title).neq("id", data.id).limit(1),
      supabaseAdmin.from("essays").select("id, title").eq("content", content).neq("id", data.id).limit(1),
    ]);
    if (byTitle.error) throw new Error(byTitle.error.message);
    if (byContent.error) throw new Error(byContent.error.message);
    const dup = byTitle.data?.[0] ?? byContent.data?.[0];
    if (dup) throw new Error(`Ein anderes Essay mit gleichem Titel/Text existiert bereits ("${dup.title}").`);

    const chunks = chunkText(content);
    if (chunks.length === 0) throw new Error("Kein Absatz erkannt.");
    if (chunks.length !== data.embeddings.length) {
      throw new Error(
        `Anzahl Absätze (${chunks.length}) und Embeddings (${data.embeddings.length}) stimmen nicht überein.`,
      );
    }

    const { error: updErr } = await supabaseAdmin
      .from("essays")
      .update({ title, content, source: data.source ?? null })
      .eq("id", data.id);
    if (updErr) throw new Error(updErr.message);

    // Index neu aufbauen: alte Chunks weg, neue rein.
    const { error: delErr } = await supabaseAdmin.from("essay_chunks").delete().eq("essay_id", data.id);
    if (delErr) throw new Error(delErr.message);

    const rows = chunks.map((text, i) => ({
      essay_id: data.id,
      chunk_index: i,
      content: text,
      embedding: JSON.stringify(data.embeddings[i]) as unknown as string,
    }));
    const { error: chunkErr } = await supabaseAdmin.from("essay_chunks").insert(rows);
    if (chunkErr) throw new Error(chunkErr.message);

    return { essay_id: data.id, chunk_count: rows.length };
  });

/** Essay samt allen Chunks aus dem RAG-Index löschen. */
export const deleteEssay = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./admin-gate.server");
    await requireAdmin();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Chunks zuerst (kein ON DELETE CASCADE vorausgesetzt).
    const { error: chunkErr } = await supabaseAdmin.from("essay_chunks").delete().eq("essay_id", data.id);
    if (chunkErr) throw new Error(chunkErr.message);
    const { error } = await supabaseAdmin.from("essays").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });


const AskSchema = z.object({
  question: z.string().min(2),
  embedding: VectorSchema,
});

/** Default cosine-similarity cutoff for retrieval (0 = alles, 1 = identisch). */
const DEFAULT_SIMILARITY_THRESHOLD = 0.3;

const SearchSchema = z.object({
  question: z.string().min(2),
  embedding: VectorSchema,
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
 * Retrieval-only variant: nimmt das lokal erzeugte Frage-Embedding und liefert
 * die Top-5 Chunks samt Similarity-Score, ohne das LLM aufzurufen.
 */
export const searchPortfolio = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => SearchSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const threshold = data.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    const { data: matches, error } = await supabaseAdmin.rpc("match_essay_chunks", {
      query_embedding: JSON.stringify(data.embedding) as unknown as string,
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

/**
 * Extraktiver Fallback ohne LLM.
 * Wird genutzt, wenn das AI Gateway nicht verfügbar ist (Credit-Limit, Rate-Limit,
 * fehlender Key). Statt einer generierten Formulierung werden die relevantesten
 * Sätze der gefundenen Absätze zu einer kurzen Zusammenfassung montiert –
 * jeweils mit Quellen-Referenz [n].
 */
function extractiveAnswer(question: string, sources: MatchRow[]): string {
  // Frage-Stichwörter (ohne Kurzwörter) für ein simples Keyword-Scoring der Sätze.
  const terms = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 3);

  const lines = sources.map((s, i) => {
    const sentences = s.content
      .split(/(?<=[.!?])\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 30);
    const scored = sentences
      .map((sentence) => {
        const lower = sentence.toLowerCase();
        const score = terms.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0);
        return { sentence, score };
      })
      .sort((a, b) => b.score - a.score);
    // Bester Satz, sonst Anfang des Absatzes als Auszug.
    const best =
      scored[0]?.score > 0
        ? scored[0].sentence
        : (sentences[0] ?? s.content).slice(0, 220).trim();
    return `„${best}“ [${i + 1}]`;
  });

  return (
    "Hinweis: Die KI-Antwort ist derzeit nicht verfügbar (Credit-Limit). " +
    "Hier stattdessen die passendsten Stellen direkt aus den Texten:\n\n" +
    lines.join("\n\n")
  );
}

export const askPortfolio = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => AskSchema.parse(data))
  .handler(async ({ data }) => {
    // Eigener OpenAI-Key hat Vorrang; sonst Fallback auf das Lovable AI Gateway.
    const openaiKey = process.env.OPENAI_API_KEY;
    const key = openaiKey ?? process.env.LOVABLE_API_KEY;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");


    // 1. Frage-Embedding kommt fertig aus dem Browser (lokales MiniLM).
    // 2. Retrieve top-5 most similar chunks via pgvector cosine similarity
    const { data: matches, error } = await supabaseAdmin.rpc("match_essay_chunks", {
      query_embedding: JSON.stringify(data.embedding) as unknown as string,
      match_count: 5,
    });
    if (error) throw new Error(error.message);

    const allMatches = (matches ?? []) as MatchRow[];

    // Keep the 3-5 best chunks: everything above the similarity threshold,
    // but always at least the top 3 so the LLM never runs without context.
    const relevant = allMatches.filter((m) => m.similarity >= DEFAULT_SIMILARITY_THRESHOLD);
    const sources = (relevant.length >= 3 ? relevant : allMatches.slice(0, 3)).slice(0, 5);

    if (sources.length === 0) {
      return {
        answer: "In den vorhandenen Texten habe ich dazu nichts gefunden.",
        fallback: false,
        sources: [],
      };
    }

    // Gesamtzahl der Absätze pro Essay ermitteln, damit die UI
    // "Absatz 3/12" anstatt nur "Absatz 3" anzeigen kann.
    const essayIds = [...new Set(sources.map((s) => s.essay_id))];
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

    const sourceList = sources.map((s, i) => ({
      ref: i + 1,
      essay_id: s.essay_id,
      title: s.title,
      source: s.source,
      // Absatz-Referenz (0-basiert im Index -> 1-basiert für die Anzeige)
      chunk_index: s.chunk_index,
      chunk_total: totals[s.essay_id] ?? 0,
      excerpt: s.content.length > 240 ? s.content.slice(0, 240) + "…" : s.content,
      similarity: s.similarity,
    }));

    // Ohne API-Key gar nicht erst das Gateway aufrufen -> direkt extraktiv antworten.
    if (!key) {
      return { answer: extractiveAnswer(data.question, sources), fallback: true, sources: sourceList };
    }

    // 3. Build a grounded prompt and ask the LLM to cite by [n]
    const context = sources
      .map((s, i) => `[${i + 1}] "${s.title}"${s.source ? ` (${s.source})` : ""}\n${s.content}`)
      .join("\n\n---\n\n");

    const systemPrompt =
      "Du beantwortest Fragen ausschließlich auf Grundlage der bereitgestellten Textausschnitte aus einer Essay-Sammlung. " +
      "Antworte auf Deutsch, präzise und in 2-5 Sätzen. Zitiere die verwendeten Quellen mit [1], [2] etc. " +
      "Nutze dabei die mitgelieferte Absatz-Information, z. B. [1, Absatz 3], wenn du auf einen konkreten Absatz verweist. " +
      "Wenn die Ausschnitte die Frage nicht beantworten, sage das ehrlich.";

    try {
      const baseUrl = openaiKey ? OPENAI_URL : GATEWAY_URL;
      const model = openaiKey ? OPENAI_MODEL : CHAT_MODEL;
      const chatRes = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
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
      if (!answer.trim()) throw new Error("Leere LLM-Antwort");
      return { answer, fallback: false, sources: sourceList };
    } catch {
      // 4. Fallback: kein LLM verfügbar (Credit-/Rate-Limit) -> extraktive
      // Zusammenfassung direkt aus den gefundenen Absätzen, inkl. Quellen.
      return { answer: extractiveAnswer(data.question, sources), fallback: true, sources: sourceList };
    }
  });

