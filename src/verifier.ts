// Optional model-backed verifier (opt-in only, never default). Constraint 3.
import type { PageObservation } from "./observation.js";

/** Noul-style check via text model; returns false on any error (fail closed). */
export async function verifyWithModel(goal: string, obs: PageObservation): Promise<boolean> {
  const key = process.env.TEXT_MODEL_API_KEY;
  if (!key) return false;
  try {
    const base = (process.env.TEXT_MODEL_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    const model = process.env.TEXT_MODEL ?? "inception/mercury-2.5";
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 16,
        messages: [
          { role: "system", content: "Answer only YES or NO. Is the user goal visibly satisfied by the page?" },
          { role: "user", content: `Goal: ${goal}\nPage: ${obs.title}\n${obs.text.slice(0, 2000)}` },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return /^\s*yes\b/i.test(data.choices[0]?.message.content ?? "");
  } catch { return false; }
}
