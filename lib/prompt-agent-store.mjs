import { join } from "node:path";
import { readJsonFileSafe, withFileTransaction, writeJsonFileAtomic } from "./atomic-json-file.mjs";

const HISTORY_FILENAME = "prompt-agent-history.json";

function normalizeHistoryEntry(entry = {}) {
  const createdAt = String(entry.createdAt || new Date().toISOString());
  const json = entry.json && typeof entry.json === "object" ? entry.json : {};

  const normalized = {
    id: String(entry.id || `prompt-json-${Date.now()}`),
    createdAt,
    filename: String(entry.filename || ""),
    imageMimeType: String(entry.imageMimeType || ""),
    imageSize: Number(entry.imageSize || 0),
    responsesModel: String(entry.responsesModel || ""),
    reasoningEffort: String(entry.reasoningEffort || ""),
  };
  if (Object.hasOwn(entry, "mode")) {
    normalized.mode = String(entry.mode || "").trim();
  }
  normalized.json = json;
  return normalized;
}

function sortHistory(entries) {
  return [...entries].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function createPromptAgentStore({ rootDir }) {
  const localDir = join(rootDir, ".local");
  const historyPath = join(localDir, HISTORY_FILENAME);

  async function list() {
    // Damaged history is quarantined and read as empty instead of failing every
    // prompt-agent request until someone deletes the file by hand.
    const parsed = await readJsonFileSafe(historyPath, { label: "prompt agent history" });
    if (parsed === null) {
      return [];
    }
    const entries = Array.isArray(parsed) ? parsed : parsed.entries;
    return sortHistory((Array.isArray(entries) ? entries : []).map(normalizeHistoryEntry));
  }

  async function save(entries) {
    await writeJsonFileAtomic(historyPath, {
      version: 1,
      entries: sortHistory(entries.map(normalizeHistoryEntry)),
    });
  }

  async function append(entry) {
    return withFileTransaction(historyPath, async () => {
      const entries = await list();
      const normalized = normalizeHistoryEntry(entry);
      await save([normalized, ...entries]);
      return normalized;
    });
  }

  return {
    historyPath,
    list,
    append,
  };
}
