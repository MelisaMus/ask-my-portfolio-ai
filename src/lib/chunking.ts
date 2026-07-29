/**
 * Gemeinsame Chunking-Logik für Client (Embedding-Erzeugung) und Server
 * (Validierung beim Ingest). MUSS auf beiden Seiten identisch laufen, sonst
 * passen Text und Vektor nicht zusammen – deshalb dieses eine Modul.
 *
 * Strategie (Absätze als Basis, aber mit Größenkorrektur):
 *   1. Rohsplit an Leerzeilen.
 *   2. Zu kurze Absätze (Überschriften, Einzeiler) werden mit dem folgenden
 *      Absatz verschmolzen – sie erzeugten sonst inhaltsarme Chunks, die als
 *      schwache Treffer den LLM-Kontext verwässern.
 *   3. Zu lange Absätze werden an Satzgrenzen aufgeteilt, damit sie nicht das
 *      512-Token-Fenster von MiniLM sprengen (stille Truncation).
 *   4. Fallback: Text ohne Leerzeilen wird komplett satzweise gepackt.
 */

/** Unter dieser Länge gilt ein Absatz als zu klein für einen eigenen Chunk. */
export const MIN_CHUNK_CHARS = 200;
/** Ab dieser Länge wird ein Absatz an Satzgrenzen aufgeteilt. */
export const MAX_CHUNK_CHARS = 1200;

/** Text in Sätze zerlegen (einfache Heuristik an Satzzeichen). */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Einen zu langen Absatz satzweise in Stücke <= MAX_CHUNK_CHARS packen. */
function packLongParagraph(paragraph: string): string[] {
  const sentences = splitSentences(paragraph);
  const out: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > MAX_CHUNK_CHARS) {
      out.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) out.push(current);
  return out.length > 0 ? out : [paragraph];
}

/**
 * Essay in Chunks zerlegen. Deterministisch – gleicher Input, gleicher Output.
 */
export function chunkText(content: string): string[] {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // Schritt 2: kurze Absätze nach vorne zusammenziehen.
  const merged: string[] = [];
  for (const paragraph of paragraphs) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      previous.length < MIN_CHUNK_CHARS &&
      previous.length + paragraph.length + 2 <= MAX_CHUNK_CHARS
    ) {
      merged[merged.length - 1] = `${previous}\n\n${paragraph}`;
    } else {
      merged.push(paragraph);
    }
  }

  // Letzter Chunk könnte noch zu kurz sein -> an den vorherigen hängen.
  if (merged.length > 1) {
    const last = merged[merged.length - 1];
    const beforeLast = merged[merged.length - 2];
    if (last.length < MIN_CHUNK_CHARS && last.length + beforeLast.length + 2 <= MAX_CHUNK_CHARS) {
      merged.pop();
      merged[merged.length - 1] = `${beforeLast}\n\n${last}`;
    }
  }

  // Schritt 3: zu lange Chunks satzweise aufteilen.
  return merged.flatMap((chunk) =>
    chunk.length > MAX_CHUNK_CHARS ? packLongParagraph(chunk) : [chunk],
  );
}
