// Programmatic example (no AI): observe → type → press. Spec §49 second test.
import { BrowserRuntime } from "../src/index.js";

const browser = await BrowserRuntime.connect({ mode: "managed" });
try {
  const page = await browser.createPage("http://localhost:3000/test");
  const state = await page.observe();
  const input = state.elements.find((e) => e.role === "textbox");
  if (!input) throw new Error("No textbox observed");
  await page.type(input.ref, "hello");
  await page.press("Enter");
  console.log("typed ok");
} finally {
  await browser.disconnect();
}
