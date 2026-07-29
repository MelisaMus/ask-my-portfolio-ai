import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { askPortfolio, searchPortfolio } from "@/lib/portfolio.functions";
import { supabase } from "@/integrations/supabase/client";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

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
  chunk_index: number;
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
  // Debug-Metadaten aus searchPortfolio
  chunk_total: number;
  char_count: number;
  word_count: number;
};

/** Kürzt einen Absatz für die Debug-Vorschau auf ein Zeichenlimit. */
const EXCERPT_LIMIT = 280;
function excerptOf(text: string) {
  return text.length <= EXCERPT_LIMIT ? text : `${text.slice(0, EXCERPT_LIMIT).trimEnd()}…`;
}

function Index() {
  const ask = useServerFn(askPortfolio);
  const search = useServerFn(searchPortfolio);

  // Ask state
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  // Konfigurierbarer Similarity-Threshold: Treffer darunter werden verworfen.
  const [threshold, setThreshold] = useState(0.3);
  const [retrieved, setRetrieved] = useState(0);
  // Vorschau der Absätze, die im normalen Modus als Kontext ans LLM gehen.
  const [contextPreview, setContextPreview] = useState<Match[]>([]);
  const [showContext, setShowContext] = useState(true);
  const [expandedChunkId, setExpandedChunkId] = useState<string | null>(null);
  // Im Test-Modus geklickter Treffer -> Detail-Sidepanel
  const [selectedMatch, setSelectedMatch] = useState<Match | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Expanded full-essay content, keyed by essay_id
  const [openEssayId, setOpenEssayId] = useState<string | null>(null);
  const [essayCache, setEssayCache] = useState<Record<string, string>>({});
  const [loadingEssayId, setLoadingEssayId] = useState<string | null>(null);




  async function onAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    setSources([]);
    setMatches([]);
    setContextPreview([]);
    setOpenEssayId(null);
    try {
      if (testMode) {
        // Retrieval-only: skip the LLM, show raw top-5 chunks + similarity scores.
        const res = await search({ data: { question, threshold } });
        setMatches(res.matches);
        setRetrieved(res.retrieved);
      } else {
        // Schritt 1: Retrieval separat ausführen, damit die Kontext-Absätze
        // schon sichtbar sind, bevor das LLM antwortet.
        const pre = await search({ data: { question, threshold: 0 } });
        setContextPreview(pre.matches);
        // Schritt 2: eigentliche RAG-Antwort (retrievt serverseitig erneut).
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

  // Exportiert die aktuellen Retrieval-Treffer (inkl. Similarity-Scores) als JSON-Datei.
  function downloadMatchesJson() {
    const payload = {
      question,
      threshold,
      retrieved,
      generated_at: new Date().toISOString(),
      matches: matches.map((m, i) => ({
        rank: i + 1,
        chunk_id: m.chunk_id,
        essay_id: m.essay_id,
        title: m.title,
        source: m.source,
        chunk_index: m.chunk_index,
        chunk_position: `${m.chunk_index + 1}/${m.chunk_total}`,
        similarity: m.similarity,
        char_count: m.char_count,
        word_count: m.word_count,
        content: m.content,
      })),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `retrieval-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
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
        {testMode && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <label htmlFor="threshold" className="whitespace-nowrap">
              Similarity-Threshold
            </label>
            <input
              id="threshold"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="w-48"
            />
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{threshold.toFixed(2)}</span>
          </div>
        )}
      </form>

      {error && (
        <p className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {testMode && retrieved > 0 && matches.length === 0 && (
        <p className="mt-6 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          Kein Treffer über dem Threshold {threshold.toFixed(2)} ({retrieved} Chunks geprüft).
        </p>
      )}

      {matches.length > 0 && (
        <section className="mt-8">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Retrieval-Ergebnisse · {matches.length}/{retrieved} über Threshold {threshold.toFixed(2)}
            </h2>
            <button
              type="button"
              onClick={downloadMatchesJson}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              JSON herunterladen
            </button>
          </div>
          <ol className="space-y-3">
            {matches.map((m, i) => (
              <li
                key={m.chunk_id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedMatch(m)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedMatch(m);
                  }
                }}
                className="cursor-pointer rounded-md border border-border bg-background p-3 text-sm transition-colors hover:border-primary/50 hover:bg-muted/40"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="font-medium">
                    <span className="text-muted-foreground">[{i + 1}] </span>
                    {m.title}
                    {m.source && (
                      <span className="ml-2 font-normal text-muted-foreground">— {m.source}</span>
                    )}
                  </p>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {m.similarity.toFixed(4)}
                  </span>
                </div>
                {/* Debug-Metadaten: Position im Essay, Länge, Chunk-ID */}
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
                  <span>
                    Absatz {m.chunk_index + 1}/{m.chunk_total}
                  </span>
                  <span>{m.char_count} Zeichen</span>
                  <span>{m.word_count} Wörter</span>
                  <span>chunk {m.chunk_id.slice(0, 8)}</span>
                  <span>essay {m.essay_id.slice(0, 8)}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap leading-relaxed text-foreground">
                  {expandedChunkId === m.chunk_id ? m.content : excerptOf(m.content)}
                </p>
                {m.content.length > EXCERPT_LIMIT && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedChunkId(expandedChunkId === m.chunk_id ? null : m.chunk_id);
                    }}
                    className="mt-1 text-xs text-primary underline underline-offset-4 hover:opacity-80"
                  >
                    {expandedChunkId === m.chunk_id
                      ? "Auszug anzeigen"
                      : `Vollen Absatz anzeigen (${m.char_count} Zeichen)`}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {!testMode && contextPreview.length > 0 && (
        <section className="mt-8">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Kontext für das LLM ({contextPreview.length} Absätze)
              {loading && " · Antwort wird erzeugt…"}
            </h2>
            <button
              type="button"
              onClick={() => setShowContext((v) => !v)}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              {showContext ? "Kontext ausblenden" : "Kontext einblenden"}
            </button>
          </div>
          {showContext && (
            <ol className="space-y-2">
              {contextPreview.map((m, i) => (
                <li
                  key={m.chunk_id}
                  className="rounded-md border border-border bg-muted/30 p-3 text-xs"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="font-medium text-foreground">
                      <span className="text-muted-foreground">[{i + 1}] </span>
                      {m.title}
                      {m.source && (
                        <span className="ml-2 font-normal text-muted-foreground">— {m.source}</span>
                      )}
                      <span className="ml-2 font-normal text-muted-foreground">
                        · Absatz {m.chunk_index + 1}
                      </span>
                    </p>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
                      {m.similarity.toFixed(3)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-3 leading-relaxed text-muted-foreground">
                    {m.content}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {error && (
        <p className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {answer && (
        <section className="mt-8">
          <div className="rounded-md border border-border bg-card p-4">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Antwort
            </h2>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{answer}</p>

            {/* Quellenangabe direkt unter der Antwort: Titel + Absatz-Referenz + Zitat */}
            <div className="mt-5 border-t border-border pt-4">
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Quellen
              </h3>
              {sources.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Keine Quellen — die Antwort stützt sich auf keinen indexierten Absatz.
                </p>
              ) : (
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
                          <span className="ml-2 font-normal text-muted-foreground">
                            · Absatz {s.chunk_index + 1}
                          </span>
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
              )}
            </div>
          </div>
        </section>
      )}

      <hr className="my-12 border-border" />

      <p className="text-sm text-muted-foreground">
        Essays einpflegen?{" "}
        <Link to="/admin" className="text-primary underline underline-offset-4">
          Zur Admin-Ansicht
        </Link>
      </p>

      {/* Sidepanel: voller Chunk-Text + Quelle (Test-Modus) */}
      <Sheet open={!!selectedMatch} onOpenChange={(open) => !open && setSelectedMatch(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
          {selectedMatch && (
            <>
              <SheetHeader>
                <SheetTitle className="text-left">{selectedMatch.title}</SheetTitle>
                <SheetDescription className="text-left">
                  {selectedMatch.source ? `${selectedMatch.source} · ` : ""}
                  Absatz {selectedMatch.chunk_index + 1}/{selectedMatch.chunk_total} · Similarity{" "}
                  {selectedMatch.similarity.toFixed(4)}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
                <span>{selectedMatch.char_count} Zeichen</span>
                <span>{selectedMatch.word_count} Wörter</span>
                <span>chunk {selectedMatch.chunk_id.slice(0, 8)}</span>
                <span>essay {selectedMatch.essay_id.slice(0, 8)}</span>
              </div>
              <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                {selectedMatch.content}
              </p>
            </>
          )}
        </SheetContent>
      </Sheet>
    </main>
  );
}
