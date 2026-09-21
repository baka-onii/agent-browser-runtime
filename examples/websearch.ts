// Harness-side web_search pattern (documentation, not an implementation).
// web_search lives in YOUR harness; the runtime only exposes the actions it needs:
// navigate → observe → type → submit → text_stable → extract → open links.
import { BrowserRuntime } from "../src/index.js";

export interface SearchHit { title: string; urlHint: string; }

export async function webSearch(query: string, maxHits = 5): Promise<{ hits: SearchHit[]; answerText: string }> {
  const browser = await BrowserRuntime.connect({ mode: "managed" });
  try {
    const page = await browser.createPage("https://www.google.com/");
    const obs = await page.observe();
    const box = obs.elements.find((e) => ["textbox", "searchbox", "combobox"].includes(e.role));
    if (!box) throw new Error("No search box observed (bot-blocked?)");
    await page.type(box.ref, query);
    await page.press("Enter");
    await page.wait({ kind: "text_stable", stableForMs: 800 }, { timeoutMs: 20000 });
    const state = await page.observe({ profile: "agent", maxTokens: 3000 });
    const hits: SearchHit[] = state.elements
      .filter((e) => e.role === "link" && e.name.trim().length > 0)
      .slice(0, maxHits)
      .map((e) => ({ title: e.name, urlHint: e.ref.id }));
    return { hits, answerText: state.text.slice(0, 4000) };
  } finally {
    await browser.disconnect();
  }
}

// const r = await webSearch("agent browser runtime");
// console.log(r.hits);
