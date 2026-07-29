/**
 * Einfacher Chatverlauf: EINE fortlaufende Unterhaltung, gespeichert im
 * Browser (localStorage). Kein Server, kein Login.
 *
 * Verwendung im RAG-Flow:
 *   - Für das LLM: die letzten Turns werden als Gesprächskontext mitgeschickt,
 *     damit Follow-up-Fragen ("und was sagt sie dazu?") verständlich sind.
 *   - Für das Retrieval: da die Suche rein auf dem Embedding der Frage beruht,
 *     wird bei kurzen Follow-ups die vorherige Frage vorangestellt
 *     (siehe `retrievalQuery`), sonst findet die Vektorsuche nichts Sinnvolles.
 */
export type ChatTurn = {
  id: string;
  question: string;
  answer: string;
  at: number;
};

const STORAGE_KEY = "ask-my-portfolio:conversation";
/** Mehr Verlauf bringt für Follow-ups kaum etwas, kostet aber Tokens. */
const MAX_TURNS = 30;
/** So viele Turns gehen als Gesprächskontext ans LLM. */
export const HISTORY_FOR_LLM = 4;

export function loadHistory(): ChatTurn[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ChatTurn[]) : [];
  } catch {
    return [];
  }
}

export function saveHistory(turns: ChatTurn[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(turns.slice(-MAX_TURNS)));
  } catch {
    /* Speicher voll oder blockiert – Verlauf ist nur ein Komfort-Feature. */
  }
}

export function clearHistory() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

/**
 * Suchtext für das Embedding. Kurze oder pronominale Follow-ups
 * ("und warum?", "erzähl mehr davon") tragen allein zu wenig Signal,
 * darum wird die letzte Frage vorangestellt.
 */
export function retrievalQuery(question: string, history: ChatTurn[]): string {
  const last = history[history.length - 1];
  if (!last) return question;
  const isShort = question.trim().split(/\s+/).length <= 6;
  const hasPronoun = /\b(das|dem|dazu|davon|dies|er|sie|es|dort|dabei|mehr)\b/i.test(question);
  return isShort || hasPronoun ? `${last.question}\n${question}` : question;
}
