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
/** Chunking-Logik ist für Client und Server dieselbe (src/lib/chunking.ts). */
import { chunkText } from "./chunking";

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1";
const CHAT_MODEL = "google/gemini-3.6-flash";
/** Eigener OpenAI-Key (Secret) – wird bevorzugt, umgeht das Workspace-Limit. */
const OPENAI_URL = "https://api.openai.com/v1";
const OPENAI_MODEL = "gpt-4o-mini";
/** Dimension des lokalen MiniLM-Modells – muss zu vector(384) passen. */
const EMBEDDING_DIM = 384;
/** Rate-Limit für die Chat-Route: N Fragen pro IP und Zeitfenster. */
const ASK_RATE_LIMIT = { max: 20, windowSeconds: 10 * 60 };


/**
 * Fehlerklassen im LLM-Pfad. Wichtig: ein Credit-/Kontingent-Problem ist etwas
 * anderes als ein echter API-, Netzwerk- oder Bugfehler – nur so lassen sich
 * Fehler im Log auseinanderhalten statt von einem Catch-all maskiert zu werden.
 */
export type LlmFailureKind =
  | "credit_limit" // 402/403: Guthaben oder Workspace-Limit erschöpft
  | "rate_limit" // 429: zu viele Anfragen
  | "auth" // 401: Key ungültig/abgelaufen
  | "bad_request" // 4xx: Prompt/Modell/Payload fehlerhaft -> unser Bug
  | "provider_error" // 5xx beim Anbieter
  | "network" // DNS/TLS/Verbindung abgebrochen
  | "timeout" // Antwort kam nicht rechtzeitig
  | "empty_response" // HTTP 200, aber kein verwertbarer Text
  | "missing_key" // gar kein Key hinterlegt – Konfigurationsproblem
  | "unknown"; // alles andere -> immer verdächtig, nie als Limit deuten

/** Nur diese Klassen sind "erwartete" Kontingentgrenzen, kein Defekt. */
const QUOTA_KINDS = new Set<LlmFailureKind>(["credit_limit", "rate_limit"]);

/** Fehler mit Klassifikation, damit UI und Logging denselben Grund kennen. */
class LlmError extends Error {
  constructor(
    readonly kind: LlmFailureKind,
    message: string,
    /** HTTP-Status, sofern es überhaupt eine Antwort gab. */
    readonly status?: number,
    /** Gekürzter Rohtext der Anbieter-Antwort – nur fürs Log. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** HTTP-Fehlerantwort -> klassifizierter Fehler mit UI-tauglichem Text. */
function httpFailure(status: number, body: string): LlmError {
  const detail = body.slice(0, 500);
  if (status === 429)
    return new LlmError("rate_limit", "Zu viele Anfragen an die KI – bitte kurz warten und erneut versuchen.", status, detail);
  if (status === 401 || status === 403)
    // 403 bedeutet beim Lovable-Gateway "Workspace-Limit", bei OpenAI dagegen
    // ein Key-/Berechtigungsproblem – deshalb am Antworttext unterscheiden.
    return /credit|quota|limit|billing/i.test(body)
      ? new LlmError("credit_limit", "KI-Guthaben/Limit ist erreicht. Bitte Guthaben aufladen.", status, detail)
      : new LlmError("auth", "Der hinterlegte API-Key ist ungültig oder nicht berechtigt.", status, detail);
  if (status === 402)
    return new LlmError("credit_limit", "KI-Guthaben/Limit ist erreicht. Bitte Guthaben aufladen.", status, detail);
  if (status >= 500)
    return new LlmError("provider_error", `Der KI-Dienst antwortet gerade nicht (Fehler ${status}).`, status, detail);
  return new LlmError("bad_request", `Fehlerhafte Anfrage an den KI-Dienst (${status}).`, status, detail);
}

/** Ausnahme aus fetch()/JSON-Parsing -> klassifizierter Fehler. */
function transportFailure(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))
    return new LlmError("timeout", "Der KI-Dienst hat nicht rechtzeitig geantwortet.", undefined, message);
  if (err instanceof TypeError)
    return new LlmError("network", "Der KI-Dienst war nicht erreichbar (Netzwerkfehler).", undefined, message);
  return new LlmError("unknown", `Unerwarteter Fehler im KI-Pfad: ${message}`, undefined, message);
}



const VectorSchema = z.array(z.number()).length(EMBEDDING_DIM);





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


/** Default cosine-similarity cutoff for retrieval (0 = alles, 1 = identisch). */
const DEFAULT_SIMILARITY_THRESHOLD = 0.3;
/** So viele Chunks gehen mindestens in den Kontext, auch unter dem Threshold. */
const MIN_CONTEXT_CHUNKS = 3;
/** Obergrenze der Kontext-Chunks (Top-k aus der Vektorsuche). */
const MATCH_COUNT = 5;

const AskSchema = z.object({
  question: z.string().min(2),
  embedding: VectorSchema,
  threshold: z.number().min(0).max(1).optional(),
  /**
   * Optionaler Gesprächsverlauf (nur die letzten Turns) aus dem Browser.
   * Wird ausschließlich als Kontext an das LLM gegeben, nicht gespeichert.
   */
  history: z
    .array(z.object({ question: z.string(), answer: z.string() }))
    .max(8)
    .optional(),
});

const SearchSchema = AskSchema.omit({ history: true });


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
 * EINE gemeinsame Auswahlregel für Test-Modus und Chat, damit der Threshold-
 * Regler exakt das zeigt, was der Chat später ans LLM schickt:
 * alles über dem Threshold, aber nie weniger als MIN_CONTEXT_CHUNKS
 * (sonst hätte das LLM gar keinen Kontext).
 */
function selectContext(all: MatchRow[], threshold: number) {
  const above = all.filter((m) => m.similarity >= threshold);
  const selected = (above.length >= MIN_CONTEXT_CHUNKS ? above : all.slice(0, MIN_CONTEXT_CHUNKS)).slice(
    0,
    MATCH_COUNT,
  );
  return {
    selected,
    aboveCount: above.length,
    // true = es wurden Chunks UNTER dem Threshold ergänzt, um auf das Minimum zu kommen
    filled: above.length < selected.length,
  };
}

/** Absatz-Gesamtzahl je Essay – eine Abfrage statt einer pro Essay (N+1). */
async function chunkTotals(
  supabaseAdmin: { from: (t: string) => any },
  essayIds: string[],
): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  if (essayIds.length === 0) return totals;
  const { data } = await supabaseAdmin
    .from("essay_chunks")
    .select("essay_id")
    .in("essay_id", essayIds);
  for (const row of (data ?? []) as { essay_id: string }[]) {
    totals[row.essay_id] = (totals[row.essay_id] ?? 0) + 1;
  }
  return totals;
}

/**
 * Retrieval-only variant: nimmt das lokal erzeugte Frage-Embedding und liefert
 * die Kontext-Auswahl samt Similarity-Score, ohne das LLM aufzurufen.
 */
export const searchPortfolio = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => SearchSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const threshold = data.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    const { data: matches, error } = await supabaseAdmin.rpc("match_essay_chunks", {
      query_embedding: JSON.stringify(data.embedding) as unknown as string,
      match_count: MATCH_COUNT,
    });
    if (error) throw new Error(error.message);
    const all = (matches ?? []) as MatchRow[];
    const { selected, aboveCount, filled } = selectContext(all, threshold);

    // Debug-Metadaten: Gesamtzahl der Absätze je Essay, damit die UI
    // "Absatz 3 von 12" statt nur "Absatz 3" anzeigen kann.
    const totals = await chunkTotals(supabaseAdmin, [...new Set(selected.map((m) => m.essay_id))]);

    return {
      threshold,
      retrieved: all.length,
      above_count: aboveCount,
      filled,
      matches: selected.map((m) => ({
        ...m,
        above_threshold: m.similarity >= threshold,
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
function extractiveAnswer(question: string, sources: MatchRow[], reason?: string): string {
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
    `Hinweis: Die KI-Antwort ist derzeit nicht verfügbar${reason ? ` (${reason})` : ""}. ` +
    "Hier stattdessen die passendsten Stellen direkt aus den Texten:\n\n" +
    lines.join("\n\n")
  );

}

export const askPortfolio = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => AskSchema.parse(data))
  .handler(async ({ data }) => {
    // 0. Rate-Limit pro IP: schützt vor unbeabsichtigten LLM-Kosten.
    const { checkRateLimit } = await import("./rate-limit.server");
    const rl = await checkRateLimit("ask", ASK_RATE_LIMIT);
    if (!rl.allowed) {
      const mins = Math.ceil(rl.retryAfterSeconds / 60);
      console.warn(`[askPortfolio] rate limit erreicht count=${rl.count}/${rl.limit}`);
      return {
        answer:
          `Zu viele Anfragen: Es sind maximal ${rl.limit} Fragen pro ` +
          `${ASK_RATE_LIMIT.windowSeconds / 60} Minuten möglich. ` +
          `Bitte in ca. ${mins} Minute${mins === 1 ? "" : "n"} erneut versuchen.`,
        fallback: true,
        fallback_kind: "rate_limit" as LlmFailureKind,
        fallback_reason: `Limit von ${rl.limit} Anfragen pro Zeitfenster erreicht.`,
        rate_limited: true,
        retry_after_seconds: rl.retryAfterSeconds,
        sources: [],
      };
    }

    // Eigener OpenAI-Key hat Vorrang; sonst Fallback auf das Lovable AI Gateway.
    const openaiKey = process.env.OPENAI_API_KEY;
    const key = openaiKey ?? process.env.LOVABLE_API_KEY;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");



    // 1. Frage-Embedding kommt fertig aus dem Browser (lokales MiniLM).
    // 2. Retrieve top-k most similar chunks via pgvector cosine similarity
    const threshold = data.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    const { data: matches, error } = await supabaseAdmin.rpc("match_essay_chunks", {
      query_embedding: JSON.stringify(data.embedding) as unknown as string,
      match_count: MATCH_COUNT,
    });
    if (error) throw new Error(error.message);

    const allMatches = (matches ?? []) as MatchRow[];

    // Exakt dieselbe Auswahlregel wie im Test-Modus (selectContext).
    const { selected: sources } = selectContext(allMatches, threshold);

    if (sources.length === 0) {
      return {
        answer: "In den vorhandenen Texten habe ich dazu nichts gefunden.",
        fallback: false,
        sources: [],
      };
    }

    // Gesamtzahl der Absätze pro Essay ermitteln, damit die UI
    // "Absatz 3/12" anstatt nur "Absatz 3" anzeigen kann.
    const totals = await chunkTotals(supabaseAdmin, [...new Set(sources.map((s) => s.essay_id))]);


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
      console.warn("[askPortfolio] kein API-Key konfiguriert – extraktiver Fallback");
      return {
        answer: extractiveAnswer(data.question, sources, "kein API-Key konfiguriert"),
        fallback: true,
        fallback_kind: "missing_key" as LlmFailureKind,
        fallback_reason: "Es ist kein KI-API-Key konfiguriert.",
        sources: sourceList,
      };
    }

    // 3. Build a grounded prompt and ask the LLM to cite by [n]
    const context = sources
      .map((s, i) => `[${i + 1}] "${s.title}"${s.source ? ` (${s.source})` : ""}\n${s.content}`)
      .join("\n\n---\n\n");

    const systemPrompt =
      "Du beantwortest Fragen ausschließlich auf Grundlage der bereitgestellten Textausschnitte aus einer Essay-Sammlung. " +
      "Antworte auf Deutsch, präzise und in 2-5 Sätzen. Zitiere die verwendeten Quellen mit [1], [2] etc. " +
      "Nutze dabei die mitgelieferte Absatz-Information, z. B. [1, Absatz 3], wenn du auf einen konkreten Absatz verweist. " +
      "Der bisherige Gesprächsverlauf dient nur dazu, Follow-up-Fragen und Bezüge zu verstehen – " +
      "inhaltliche Aussagen stützt du weiterhin ausschließlich auf die Textausschnitte. " +
      "Wenn die Ausschnitte die Frage nicht beantworten, sage das ehrlich.";

    // Bisherige Turns als echte Chat-Nachrichten -> Follow-ups verstehen Bezüge.
    const historyMessages = (data.history ?? []).flatMap((t) => [
      { role: "user" as const, content: t.question },
      { role: "assistant" as const, content: t.answer },
    ]);


    const provider = openaiKey ? "openai" : "lovable-gateway";
    const baseUrl = openaiKey ? OPENAI_URL : GATEWAY_URL;
    const model = openaiKey ? OPENAI_MODEL : CHAT_MODEL;
    const startedAt = Date.now();

    try {
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
        // Ohne Timeout hängt eine tote Verbindung bis zum Worker-Limit.
        signal: AbortSignal.timeout(30_000),
      });
      if (!chatRes.ok) throw httpFailure(chatRes.status, await chatRes.text());

      const chatJson = (await chatRes.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const answer = chatJson.choices?.[0]?.message?.content ?? "";
      if (!answer.trim())
        throw new LlmError("empty_response", "Die KI hat keine verwertbare Antwort geliefert.", 200);

      console.info(
        `[askPortfolio] ok provider=${provider} model=${model} ms=${Date.now() - startedAt} chunks=${sources.length}`,
      );
      return { answer, fallback: false, sources: sourceList };
    } catch (err) {
      // 4. Fallback: extraktive Antwort aus den gefundenen Absätzen.
      // Jeder Fehler wird klassifiziert geloggt – Kontingentgrenzen als warn,
      // echte API-/Netz-/Codefehler als error, damit sie nicht als
      // "Credit-Limit" durchgehen.
      const failure = transportFailure(err);
      const isQuota = QUOTA_KINDS.has(failure.kind);
      const logLine =
        `[askPortfolio] LLM fehlgeschlagen kind=${failure.kind} provider=${provider} model=${model}` +
        ` status=${failure.status ?? "-"} ms=${Date.now() - startedAt} msg=${failure.message}` +
        (failure.detail ? ` detail=${failure.detail}` : "");
      if (isQuota) console.warn(logLine);
      else console.error(logLine, err);

      return {
        answer: extractiveAnswer(data.question, sources, failure.message),
        fallback: true,
        fallback_kind: failure.kind,
        fallback_reason: failure.message,
        sources: sourceList,
      };
    }


  });

