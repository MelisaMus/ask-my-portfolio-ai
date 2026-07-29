import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { ingestEssay } from "@/lib/portfolio.functions";
import { supabase } from "@/integrations/supabase/client";

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

function Admin() {
  const ingest = useServerFn(ingestEssay);

  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [content, setContent] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [essays, setEssays] = useState<EssayRow[]>([]);

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

  async function onIngest(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Werte direkt aus dem Formular lesen, damit auch programmatische
    // Eingaben ohne React-State-Update funktionieren.
    const form = e.currentTarget;
    const fd = new FormData(form);
    const t = String(fd.get("title") || "").trim();
    const s = String(fd.get("source") || "").trim();
    const c = String(fd.get("content") || "").trim();
    if (!t || !c) return;
    setIngesting(true);
    setMsg(null);
    try {
      // Ingest = Chunking (Absätze) -> Embedding je Chunk -> Insert in essay_chunks.
      const res = await ingest({ data: { title: t, content: c, source: s || null } });
      setMsg({ kind: "ok", text: `Essay gespeichert, ${res.chunk_count} Absätze eingebettet.` });
      form.reset();
      setTitle("");
      setSource("");
      setContent("");
      void loadEssays();
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : "Fehler beim Einfügen" });
    } finally {
      setIngesting(false);
    }
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
          disabled={ingesting || !title.trim() || !content.trim()}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {ingesting ? "Wird eingebettet…" : "Essay einbetten & speichern"}
        </button>
        {msg && (
          <p
            className={
              msg.kind === "ok"
                ? "rounded-md border border-primary/30 bg-primary/10 p-3 text-sm text-foreground"
                : "rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            }
          >
            {msg.text}
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
