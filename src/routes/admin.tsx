import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { ingestEssay } from "@/lib/portfolio.functions";
import { supabase } from "@/integrations/supabase/client";
import { chunkText, embedManyLocally } from "@/lib/local-embeddings";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Admin – Essays einpflegen | Ask my Portfolio" },
      {
        name: "description",
        content:
          "Admin-Ansicht: Essay mit Titel, Quelle und Volltext einfügen, Absätze chunken und Embeddings in den RAG-Index schreiben.",
      },
      { property: "og:title", content: "Admin – Essays einpflegen" },
      {
        property: "og:description",
        content: "Essays einpflegen und den RAG-Ingest (Chunking + Embeddings) auslösen.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Admin,
});

type EssayRow = { id: string; title: string; source: string | null; created_at: string };

/** Erkennt den Gateway-403 „Workspace credit limit reached“ anhand der Fehlermeldung. */
function isCreditLimit(message: string) {
  return /credit limit|Guthaben\/Limit|403/i.test(message);
}

/** Wartezeit vor dem nächsten Auto-Retry: 30s, 60s, 120s, 240s, max. 300s. */
function retryDelay(attempt: number) {
  return Math.min(30 * 2 ** (attempt - 1), 300);
}

type Status =
  | { kind: "idle" }
  | { kind: "running"; attempt: number }
  | { kind: "waiting"; attempt: number; secondsLeft: number; reason: string }
  | { kind: "ok"; text: string }
  | { kind: "err"; text: string };

function Admin() {
  const ingest = useServerFn(ingestEssay);

  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [essays, setEssays] = useState<EssayRow[]>([]);
  // Fortschritt des lokalen MiniLM-Modells (Download + Embedding je Absatz)
  const [progress, setProgress] = useState<string | null>(null);
  // Zwischenspeicher, damit der Auto-Retry dieselben Daten erneut senden kann.
  const pending = useRef<{ title: string; source: string | null; content: string } | null>(null);
  const cancelled = useRef(false);

  const ingesting = status.kind === "running";

  // Bereits indexierte Essays anzeigen (reiner Lesezugriff über RLS).
  async function loadEssays() {
    const { data } = await supabase
      .from("essays")
      .select("id, title, source, created_at")
      .order("created_at", { ascending: false });
    setEssays((data as EssayRow[] | null) ?? []);
  }

  useEffect(() => {
    void loadEssays();
  }, []);

  const chunkCount = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean).length;

  /** Führt einen Ingest-Versuch aus; bei Credit-Limit wird automatisch neu gestartet. */
  async function runIngest(attempt: number) {
    const payload = pending.current;
    if (!payload) return;
    cancelled.current = true; // laufenden Countdown stoppen
    setStatus({ kind: "running", attempt });
    try {
      // Ingest = Chunking (Absätze) -> lokales Embedding je Chunk im Browser
      // (MiniLM, 384 Dim., kein AI-Guthaben nötig) -> Insert in essay_chunks.
      const chunks = chunkText(payload.content);
      const embeddings = await embedManyLocally(chunks, setProgress);
      setProgress(null);
      const res = await ingest({ data: { ...payload, embeddings } });
      pending.current = null;
      setStatus({ kind: "ok", text: `Essay gespeichert, ${res.chunk_count} Absätze eingebettet.` });
      setTitle("");
      setSource("");
      setContent("");
      void loadEssays();
    } catch (err) {
      setProgress(null);
      const text = err instanceof Error ? err.message : "Fehler beim Einfügen";
      if (isCreditLimit(text)) {
        // Klarer Grund + automatischer Neustart nach Backoff.
        scheduleRetry(attempt + 1, text);
      } else {
        pending.current = null;
        setStatus({ kind: "err", text });
      }
    }
  }

  function scheduleRetry(nextAttempt: number, reason: string) {
    cancelled.current = false;
    let secondsLeft = retryDelay(nextAttempt - 1);
    setStatus({ kind: "waiting", attempt: nextAttempt, secondsLeft, reason });
    const timer = setInterval(() => {
      if (cancelled.current) {
        clearInterval(timer);
        return;
      }
      secondsLeft -= 1;
      if (secondsLeft <= 0) {
        clearInterval(timer);
        void runIngest(nextAttempt);
      } else {
        setStatus({ kind: "waiting", attempt: nextAttempt, secondsLeft, reason });
      }
    }, 1000);
  }

  function cancelRetry() {
    cancelled.current = true;
    pending.current = null;
    setStatus({ kind: "err", text: "Auto-Retry abgebrochen." });
  }

  async function onIngest(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Werte direkt aus dem Formular lesen, damit auch programmatische
    // Eingaben ohne React-State-Update funktionieren.
    const fd = new FormData(e.currentTarget);
    const t = String(fd.get("title") || "").trim();
    const s = String(fd.get("source") || "").trim();
    const c = String(fd.get("content") || "").trim();
    if (!t || !c) return;
    cancelled.current = false;
    pending.current = { title: t, source: s || null, content: c };
    await runIngest(1);
  }


  return (
    <main className="mx-auto min-h-screen max-w-2xl px-6 py-16">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Admin – Essays einpflegen
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Titel, optionale Quelle und Volltext eintragen. Absätze werden per Leerzeile getrennt,
          jeder Absatz wird eingebettet und in den RAG-Index geschrieben.
        </p>
        <Link to="/" className="mt-3 inline-block text-sm text-primary underline underline-offset-4">
          ← Zurück zum Chat
        </Link>
      </header>

      <form onSubmit={onIngest} className="space-y-3">
        <input
          name="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Titel"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <input
          name="source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="Quelle (z. B. InZeitung 2024)"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <textarea
          name="content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Volltext (Absätze durch Leerzeilen trennen)"
          rows={14}
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        {content.trim() && (
          <p className="text-xs text-muted-foreground">
            Vorschau: {chunkCount} Absätze werden als Chunks eingebettet.
          </p>
        )}
        <button
          type="submit"
          disabled={
            ingesting || status.kind === "waiting" || !title.trim() || !content.trim()
          }
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {ingesting ? "Wird eingebettet…" : "Essay einbetten & speichern"}
        </button>

        {/* Ingest-Statusanzeige: laufend / Auto-Retry bei Credit-Limit / Erfolg / Fehler */}
        {status.kind === "running" && (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            Ingest läuft… (Versuch {status.attempt}) – Absätze werden eingebettet.
          </p>
        )}
        {status.kind === "waiting" && (
          <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <p className="font-medium text-destructive">
              Ingest pausiert: Workspace-Credit-Limit erreicht (HTTP 403)
            </p>
            <p className="text-muted-foreground">
              Das AI-Gateway blockiert die Embeddings, solange das Workspace-Credit-Limit erreicht
              ist. Bitte unter <span className="font-medium">Settings → Plans &amp; credits</span> das
              Limit anheben – der Ingest startet danach automatisch neu.
            </p>
            <p className="text-muted-foreground">
              Nächster automatischer Versuch (Nr. {status.attempt}) in {status.secondsLeft}s.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void runIngest(status.attempt)}
                className="rounded-md border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-muted"
              >
                Jetzt erneut versuchen
              </button>
              <button
                type="button"
                onClick={cancelRetry}
                className="rounded-md border border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
              >
                Abbrechen
              </button>
            </div>
          </div>
        )}
        {status.kind === "ok" && (
          <p className="rounded-md border border-primary/30 bg-primary/10 p-3 text-sm text-foreground">
            {status.text}
          </p>
        )}
        {status.kind === "err" && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {status.text}
          </p>
        )}

      </form>

      <section className="mt-12">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Indexierte Essays ({essays.length})
        </h2>
        {essays.length === 0 ? (
          <p className="text-sm text-muted-foreground">Noch keine Essays im Index.</p>
        ) : (
          <ul className="space-y-2">
            {essays.map((e) => (
              <li key={e.id} className="rounded-md border border-border bg-background p-3 text-sm">
                <p className="font-medium text-foreground">{e.title}</p>
                <p className="text-xs text-muted-foreground">
                  {e.source ?? "ohne Quelle"} · {new Date(e.created_at).toLocaleDateString("de-DE")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
