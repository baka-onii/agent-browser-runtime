// Small text helper: typed field values only when operation is TYPE_TEXT.
// Output must parse as {"text": string|null}; never invented PII.
import { TEXT_VALUE } from "./prompts.js";

export interface TextHelperResult { text: string; model: string; latencyMs: number; usage?: unknown; }

export async function fieldText(context: {
  goal: string; field: { label?: string; role?: string; value?: string };
  page: { title: string; text: string }; recent_actions: { action?: string; text?: string | null }[];
}): Promise<TextHelperResult> {
  const key = process.env.TEXT_MODEL_API_KEY;
  if (!key) throw new Error("TYPE_TEXT needs TEXT_MODEL_API_KEY; no text is hardcoded or guessed by the executor.");
  const base = (process.env.TEXT_MODEL_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const model = process.env.TEXT_MODEL ?? "inception/mercury-2.5";
  const started = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, max_tokens: 1024, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: TEXT_VALUE },
        { role: "user", content: JSON.stringify(context) },
      ],
    }),
    signal: AbortSignal.timeout(25_000),
  }).catch(() => { throw new Error("Text helper connection failed; nothing typed."); });
  if (!res.ok) throw new Error(`Text helper HTTP ${res.status}; nothing typed.`);
  const data = (await res.json()) as { choices: { message: { content: string } }[]; usage?: unknown };
  try {
    const out = JSON.parse(data.choices[0]!.message.content) as { text?: unknown };
    if (Object.keys(out).length !== 1 || typeof out.text !== "string" || !out.text.trim() || out.text.length > 2000) {
      throw new Error("bad shape");
    }
    return { text: out.text, model, latencyMs: Date.now() - started, usage: data.usage };
  } catch {
    throw new Error("Text helper returned no valid field value; nothing typed.");
  }
}

export function fieldContext(goal: string, action: { label: string; role?: string; value?: string }, page: { title: string; text: string }, history: { action: string; text?: string | null }[]) {
  return {
    goal,
    field: { label: action.label, role: action.role, value: action.value },
    page: { title: page.title, text: page.text.slice(0, 6000) },
    recent_actions: history.slice(-6).map((h) => ({ action: h.action, text: h.text })),
  };
}
