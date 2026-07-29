import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { askPortfolio, ingestEssay, searchPortfolio } from "@/lib/portfolio.functions";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Ask my Portfolio" },
      {
        name: "description",
        content:
          "RAG-basierter Chatbot für eigene Essays – Frage stellen, Antwort mit Quellenangabe erhalten.",
      },
      { property: "og:title", content: "Ask my Portfolio" },
      {
        property: "og:description",
        content:
          "RAG-basierter Chatbot für eigene Essays – Frage stellen, Antwort mit Quellenangabe erhalten.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

type Source = {
  ref: number;
  essay_id: string;
  title: string;
  source: string | null;
  excerpt: string;
  similarity: number;
};

type Match = {
  chunk_id: string;
  essay_id: string;
  title: string;
  source: string | null;
  chunk_index: number;
  content: string;
  similarity: number;
};

function Index() {
  const ask = useServerFn(askPortfolio);
  const search = useServerFn(searchPortfolio);
  const ingest = useServerFn(ingestEssay);

  // Ask state
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Expanded full-essay content, keyed by essay_id
  const [openEssayId, setOpenEssayId] = useState<string | null>(null);
  const [essayCache, setEssayCache] = useState<Record<string, string>>({});
  const [loadingEssayId, setLoadingEssayId] = useState<string | null>(null);

  // Ingest state
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [content, setContent] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [ingestMsg, setIngestMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function onAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    setSources([]);
    setMatches([]);
    setOpenEssayId(null);
    try {
      if (testMode) {
        // Retrieval-only: skip the LLM, show raw top-5 chunks + similarity scores.
        const res = await search({ data: { question } });
        setMatches(res.matches);
      } else {
        const res = await ask({ data: { question } });
        setAnswer(res.answer);
        setSources(res.sources);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fehler");
    } finally {
      setLoading(false);
    }
  }

  // Toggle full-text view for a source; lazy-load the essay content.
  async function toggleEssay(essayId: string) {
    if (openEssayId === essayId) {
      setOpenEssayId(null);
      return;
    }
    setOpenEssayId(essayId);
    if (!essayCache[essayId]) {
      setLoadingEssayId(essayId);
      const { data, error: err } = await supabase
        .from("essays")
        .select("content")
        .eq("id", essayId)
        .single();
      if (!err && data) {
        setEssayCache((c) => ({ ...c, [essayId]: data.content }));
      }
      setLoadingEssayId(null);
    }
  }

  async function onIngest(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    setIngesting(true);
    setIngestMsg(null);
    try {
      const res = await ingest({ data: { title, content, source: source || null } });
      setIngestMsg(`Essay gespeichert, ${res.chunk_count} Absätze eingebettet.`);
      setTitle("");
      setSource("");
      setContent("");
    } catch (err) {
      setIngestMsg(err instanceof Error ? err.message : "Fehler beim Einfügen");
    } finally {
      setIngesting(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-6 py-16">
      <header className="mb-10">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">Ask my Portfolio</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Stell eine Frage – die Antwort stammt aus meiner Essay-Sammlung, mit Quellenangabe.
        </p>
      </header>

      <form onSubmit={onAsk} className="space-y-3">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="z. B. Welcher Text handelt von Wechseljahren?"
          rows={3}
          className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex items-center justify-between gap-3">
          <button
            type="submit"
            disabled={loading || !question.trim()}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Suche in Essays…" : testMode ? "Nur Retrieval testen" : "Senden"}
          </button>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={testMode}
              onChange={(e) => setTestMode(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Test-Modus (Top-5 Chunks ohne LLM)
          </label>
        </div>
      </form>

      {error && (
        <p className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {matches.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Top-5 Retrieval-Ergebnisse
          </h2>
          <ol className="space-y-3">
            {matches.map((m, i) => (
              <li key={m.chunk_id} className="rounded-md border border-border bg-background p-3 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="font-medium">
                    <span className="text-muted-foreground">[{i + 1}] </span>
                    {m.title}
                    {m.source && (
                      <span className="ml-2 font-normal text-muted-foreground">— {m.source}</span>
                    )}
                    <span className="ml-2 font-normal text-muted-foreground">
                      · Absatz {m.chunk_index + 1}
                    </span>
                  </p>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {m.similarity.toFixed(4)}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap leading-relaxed text-foreground">
                  {m.content}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}

      {error && (
        <p className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {answer && (
        <section className="mt-8 space-y-6">
          <div className="rounded-md border border-border bg-card p-4">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Antwort
            </h2>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{answer}</p>
          </div>

          {sources.length > 0 && (
            <div>
              <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Quellen
              </h2>
              <ol className="space-y-3">
                {sources.map((s) => {
                  const isOpen = openEssayId === s.essay_id;
                  return (
                    <li key={s.ref} className="rounded-md border border-border bg-background p-3 text-sm">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="font-medium">
                          <span className="text-muted-foreground">[{s.ref}] </span>
                          <button
                            type="button"
                            onClick={() => toggleEssay(s.essay_id)}
                            className="text-primary underline underline-offset-4 hover:opacity-80"
                          >
                            {s.title}
                          </button>
                          {s.source && (
                            <span className="ml-2 font-normal text-muted-foreground">— {s.source}</span>
                          )}
                        </p>
                        <span className="text-xs text-muted-foreground">
                          {(s.similarity * 100).toFixed(0)}%
                        </span>
                      </div>
                      <p className="mt-1 text-muted-foreground">"{s.excerpt}"</p>
                      {isOpen && (
                        <div className="mt-3 rounded-md border border-border bg-muted/40 p-3 text-sm">
                          {loadingEssayId === s.essay_id && !essayCache[s.essay_id] ? (
                            <p className="text-muted-foreground">Lade Volltext…</p>
                          ) : (
                            <p className="whitespace-pre-wrap leading-relaxed text-foreground">
                              {essayCache[s.essay_id]}
                            </p>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </section>
      )}

      <hr className="my-12 border-border" />

      <section>
        <h2 className="text-lg font-semibold text-foreground">Essay hinzufügen</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Titel, optionale Quelle und Volltext eintragen. Absätze werden per Leerzeile getrennt,
          jeder Absatz wird eingebettet und in den RAG-Index geschrieben.
        </p>

        <form onSubmit={onIngest} className="mt-4 space-y-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Titel"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="Quelle (z. B. InZeitung 2024)"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Volltext (Absätze durch Leerzeilen trennen)"
            rows={12}
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {content.trim() && (
            <p className="text-xs text-muted-foreground">
              Vorschau: {content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).length}{" "}
              Absätze werden als Chunks eingebettet.
            </p>
          )}
          <button
            type="submit"
            disabled={ingesting || !title.trim() || !content.trim()}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {ingesting ? "Wird eingebettet…" : "Essay einbetten & speichern"}
          </button>
          {ingestMsg && <p className="text-xs text-muted-foreground">{ingestMsg}</p>}
        </form>
      </section>

    </main>
  );
}
