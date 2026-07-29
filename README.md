# Ask my Portfolio

Ein kleiner RAG-Chatbot, der Fragen zu einer persönlichen Essay-Sammlung beantwortet – inklusive Angabe, aus welchem Text die Antwort stammt.

## Zweck

Statt Essays selbst zu durchsuchen, kann man fragen wie:

- „Welcher Text handelt von Wechseljahren?"
- „Zeig mir Stellen über Migration."

Das System sucht semantisch (nicht per Stichwort) in den eigenen Texten, formuliert eine Antwort und nennt die verwendeten Quellen. Klick auf den Titel öffnet den Volltext des Essays.

## RAG-Architektur

Retrieval-Augmented Generation in vier Schritten:

### 1. Chunking

Beim Einfügen eines Essays wird der Volltext an Leerzeilen in Absätze zerlegt (`src/lib/portfolio.functions.ts` → `chunkText`). Ein Absatz ist die Retrieval-Einheit – klein genug für gezielte Treffer, groß genug, um Kontext zu tragen.

### 2. Embedding

Für jeden Absatz wird über das **Lovable AI Gateway** ein Embedding-Vektor erzeugt (`openai/text-embedding-3-small`, 1536 Dimensionen). Absatz + Vektor werden in `essay_chunks` gespeichert, verknüpft per Foreign Key mit `essays`.

### 3. Similarity Search

Bei einer Nutzerfrage wird die Frage selbst embedded und dann per **pgvector** und Cosine-Similarity gegen alle Chunks verglichen. Die SQL-Funktion `match_essay_chunks(query_embedding, match_count)` liefert die Top-5-Treffer inklusive Essay-Titel, Quelle und Similarity-Score. Ein HNSW-Index (`vector_cosine_ops`) hält die Suche auch bei mehr Texten schnell.

### 4. LLM-Antwort mit Quellenangabe

Die gefundenen Absätze werden nummeriert (`[1]`, `[2]` …) und zusammen mit der Frage an ein Chat-Modell (`google/gemini-3.6-flash`) geschickt. Der System-Prompt hält das Modell dazu an, nur auf Basis der Ausschnitte zu antworten und die Quellen per `[n]` zu zitieren. In der UI werden die Quellen darunter mit klickbarem Titel, Original-Quelle und einem kurzen Zitat aufgelistet.

```
Frage → embed → pgvector Top-5 → LLM mit Kontext → Antwort + Quellen
```

## Datenmodell

- **`essays`** – `id`, `title`, `content`, `source`, `created_at`
- **`essay_chunks`** – `id`, `essay_id` (FK), `chunk_index`, `content`, `embedding vector(1536)`, `created_at`
- **`match_essay_chunks(query_embedding, match_count)`** – SQL-Function für die Similarity-Suche

Public Read via RLS, Schreibzugriff nur über die Server-Function `ingestEssay` (Service-Role-Client).

## Tech-Stack

- **TanStack Start** (React 19, Vite 7) – Full-Stack-Framework mit typed Server Functions
- **TypeScript** + **Tailwind CSS v4**
- **Lovable Cloud** (Supabase) – Postgres, RLS, `pgvector` (HNSW-Index)
- **Lovable AI Gateway** – Embedding-Modell `openai/text-embedding-3-small`, Chat-Modell `google/gemini-3.6-flash`

## Projektstruktur

```
src/
├── routes/
│   ├── __root.tsx              # Layout + Head-Meta
│   └── index.tsx               # UI: Frage, Antwort, Quellen, Ingest-Form
├── lib/
│   └── portfolio.functions.ts  # ingestEssay + askPortfolio (RAG-Kern)
└── integrations/supabase/      # Auto-generierte Clients (Cloud)
```

Die gesamte RAG-Logik lebt in **`src/lib/portfolio.functions.ts`** – dort sind `chunkText`, `embed`, `ingestEssay` und `askPortfolio` kommentiert und übersichtlich hintereinander.

## Lokal starten

```bash
bun install
bun run dev
```

Die App läuft dann auf `http://localhost:8080`.

Benötigte Env-Variablen (bei Lovable Cloud automatisch gesetzt):

- `LOVABLE_API_KEY` – für Gateway-Zugriff (Embeddings + Chat)
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (Browser-Client)

## Essays einfügen

Unten auf der Seite auf **„Essay hinzufügen"** klicken, dann Titel, Quelle und Volltext eintragen (Absätze durch Leerzeilen trennen). Beim Speichern wird jeder Absatz automatisch embedded und indexiert.
