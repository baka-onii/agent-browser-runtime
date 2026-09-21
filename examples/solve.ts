// Agentic example: solve with caller verifier. Spec §49 first test shape.
import { BrowserRuntime } from "../src/index.js";

const browser = await BrowserRuntime.connect({ mode: "managed" });
try {
  const page = await browser.createPage("https://example.com");
  console.log(await page.observe({ profile: "minimal" }));
  const result = await page.solve("Open the More Information link.", {
    verifier: async (_goal, obs) => obs.url.includes("iana") || /more information/i.test(obs.text),
  });
  console.log(result);
} finally {
  await browser.disconnect();
}
