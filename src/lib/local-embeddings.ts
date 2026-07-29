/**
 * Lokale Embeddings (browser-only).
 *
 * Statt einer Embedding-API läuft hier das Modell `Xenova/all-MiniLM-L6-v2`
 * direkt im Browser (WASM/WebGPU via transformers.js). Es erzeugt
 * 384-dimensionale, bereits L2-normalisierte Vektoren – passend zur
 * Spalte `essay_chunks.embedding vector(384)`.
 *
 * Wichtig: Das Modell (~25 MB) wird beim ersten Aufruf lazy geladen und
 * danach im Browser-Cache gehalten. Die Datei darf nie serverseitig
 * (SSR/Worker) ausgeführt werden – deshalb dynamischer Import.
 */

export const EMBEDDING_DIM = 384;
export const LOCAL_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractorPromise: Promise<any> | null = null;

/** Lädt die Feature-Extraction-Pipeline einmalig (Singleton). */
async function getExtractor(onProgress?: (msg: string) => void) {
  if (typeof window === "undefined") {
    throw new Error("Lokale Embeddings laufen nur im Browser.");
  }
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return pipeline("feature-extraction", LOCAL_EMBED_MODEL, {
        // Quantisiertes Modell -> deutlich kleinerer Download
        dtype: "q8",
        progress_callback: (p: { status?: string; progress?: number }) => {
          if (p?.status === "progress" && typeof p.progress === "number") {
            onProgress?.(`Modell wird geladen… ${Math.round(p.progress)}%`);
          }
        },
      });
    })();
  }
  return extractorPromise;
}

/** Ein Embedding für einen Text (mean pooling + L2-Normalisierung). */
export async function embedTextLocally(
  text: string,
  onProgress?: (msg: string) => void,
): Promise<number[]> {
  const extractor = await getExtractor(onProgress);
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array).map((v) => Number(v));
}

/** Embeddings für viele Chunks, sequentiell mit Fortschrittsmeldung. */
export async function embedManyLocally(
  texts: string[],
  onProgress?: (msg: string) => void,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    onProgress?.(`Embedding ${i + 1}/${texts.length}…`);
    vectors.push(await embedTextLocally(texts[i], onProgress));
  }
  return vectors;
}

/** Absatz-Chunking – identisch zur Server-Logik, damit Index & Vektoren passen. */
export function chunkText(content: string): string[] {
  return content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
