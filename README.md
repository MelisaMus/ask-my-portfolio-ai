# Ask my Portfolio

Ein kleiner RAG-Chatbot, der Fragen zu einer persönlichen Essay-Sammlung beantwortet – inklusive Angabe, aus welchem Text die Antwort stammt.

## Zweck

Statt Essays selbst zu durchsuchen, kann man fragen wie:

- „Welcher Text handelt von Parität?"
- „Zeig mir Stellen über Migration."

Das System sucht semantisch (nicht per Stichwort) in den eigenen Texten, formuliert eine Antwort und nennt die verwendeten Quellen. Klick auf den Titel öffnet den Volltext des Essays.

## RAG-Architektur

Retrieval-Augmented Generation in vier Schritten:

### 1. Chunking

Beim Einfügen eines Essays wird der Volltext an Leerzeilen in Absätze zerlegt (`src/lib/chunking.ts` → `chunkText`). Ein Absatz ist die Retrieval-Einheit – klein genug für gezielte Treffer, groß genug, um Kontext zu tragen.

### 2. Embedding

Für jeden Absatz wird **lokal im Browser** ein Embedding-Vektor erzeugt: das quantisierte Modell `Xenova/all-MiniLM-L6-v2` läuft per transformers.js (WASM/WebGPU) und liefert 384-dimensionale, L2-normalisierte Vektoren. Es fällt dafür kein API-Guthaben an; das Modell (~25 MB) wird beim ersten Aufruf lazy geladen und danach im Browser gecacht. Die fertigen Vektoren werden an die Server-Function `ingestEssay` geschickt. Absatz + Vektor werden in `essay_chunks` gespeichert, verknüpft per Foreign Key mit `essays`.

### 3. Similarity Search

Bei einer Nutzerfrage wird die Frage – ebenfalls lokal im Browser – embedded und dann per **pgvector** und Cosine-Similarity gegen alle Chunks verglichen. Die SQL-Funktion `match_essay_chunks(query_embedding, match_count)` liefert die Top-5-Treffer inklusive Essay-Titel, Quelle und Similarity-Score. Ein HNSW-Index (`vector_cosine_ops`) hält die Suche auch bei mehr Texten schnell.

### 4. LLM-Antwort mit Quellenangabe

Die gefundenen Absätze werden nummeriert (`[1]`, `[2]` …) und zusammen mit der Frage an ein Chat-Modell (`google/gemini-3.6-flash`) geschickt. Der System-Prompt hält das Modell dazu an, nur auf Basis der Ausschnitte zu antworten und die Quellen per `[n]` zu zitieren. In der UI werden die Quellen darunter mit klickbarem Titel, Original-Quelle und einem kurzen Zitat aufgelistet.

```
Frage → embed → pgvector Top-5 → LLM mit Kontext → Antwort + Quellen
```

## Datenmodell

- **`essays`** – `id`, `title`, `content`, `source`, `created_at`
- **`essay_chunks`** – `id`, `essay_id` (FK), `chunk_index`, `content`, `embedding vector(384)`, `created_at`
- **`match_essay_chunks(query_embedding, match_count)`** – SQL-Function für die Similarity-Suche

Public Read via RLS, Schreibzugriff nur über die Server-Function `ingestEssay` (Service-Role-Client).

## Tech-Stack

- **TanStack Start** (React 19, Vite 7) – Full-Stack-Framework mit typed Server Functions
- **TypeScript** + **Tailwind CSS v4**
- **Lovable Cloud** (Supabase) – Postgres, RLS, `pgvector` (HNSW-Index)
- **transformers.js** (`@huggingface/transformers`) – lokales Embedding-Modell `Xenova/all-MiniLM-L6-v2` (384 Dim., browser-only)
- **Lovable AI Gateway** – Chat-Modell `google/gemini-3.6-flash` für die Antwortsynthese

## Projektstruktur

```
src/
├── routes/
│   ├── __root.tsx              # Layout + Head-Meta
│   ├── index.tsx               # UI: Chat + Quellen
│   └── admin.tsx               # Admin: Ingest + CRUD
├── lib/
│   ├── portfolio.functions.ts  # ingestEssay + askPortfolio (RAG-Kern)
│   ├── chunking.ts             # chunkText + intelligenter Chunking
│   ├── local-embeddings.ts     # browserseitiges Embedding
│   └── chat-history.ts         # lokaler Chat-Verlauf
└── integrations/supabase/      # Auto-generierte Clients (Cloud)
```

Die gesamte RAG-Logik lebt in **`src/lib/portfolio.functions.ts`** – dort sind `ingestEssay` und `askPortfolio` kommentiert und übersichtlich hintereinander.

## Lokal starten

```bash
bun install
bun run dev
```

Die App läuft dann auf `http://localhost:8080`.

Benötigte Env-Variablen (bei Lovable Cloud automatisch gesetzt):

- `LOVABLE_API_KEY` – nur noch für den Chat-Aufruf (Embeddings laufen lokal)
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (Browser-Client)

## Essays einfügen

Im Admin-Bereich (`/admin`) auf **„Essay hinzufügen"** klicken, dann Titel, Quelle und Volltext eintragen (Absätze durch Leerzeilen trennen). Beim Speichern wird jeder Absatz automatisch embedded und indexiert.

## Admin-Zugang

Der Admin-Bereich ist passwortgeschützt. Das Passwort wird über `ADMIN_PASSWORD` konfiguriert und in einer verschlüsselten Cookie-Session gespeichert.
