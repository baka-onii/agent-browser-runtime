// Live test: send a message to chat.deepseek.com, wait for the streamed reply, print it.
// Run: npx tsx scripts/deepseek-live.ts
// Uses a VISIBLE managed browser with a persistent profile so login persists.
// If login is required, the script waits (up to 3 min) for you to log in manually.
import { BrowserRuntime } from "../src/index.js";

const URL = "https://chat.deepseek.com/";
const MESSAGE = "Please reply with exactly this string and nothing else: HELLO-RUNTIME-OK";
const PROFILE = "C:\\Users\\acer\\AppData\\Local\\Temp\\abr-deepseek-profile";

const browser = await BrowserRuntime.connect({
  mode: "managed", // Chrome auto-detected
  browser: { profileDir: PROFILE },
  headless: false,
  viewport: { width: 1280, height: 900 },
});

const dump = (obs: { elements: { role: string; name: string }[]; title: string; url: string }) => {
  console.log(`--- ${obs.title} | ${obs.url}`);
  for (const e of obs.elements.slice(0, 60)) console.log(`  [${e.role}] ${e.name.slice(0, 100)}`);
};

try {
  const page = await browser.createPage(URL);
  // If DeepSeek shows the login page, wait (up to 10 min) for a MANUAL login
  // in the opened window. The profile persists, so this is one-time.
  let obs = null;
  let input = null;
  for (let i = 0; i < 120; i++) {
    obs = await page.observe();
    const onLoginPage = /sign_in|login|auth/i.test(obs.url);
    if (onLoginPage) {
      if (i % 6 === 0) {
        console.log(`LOGIN NEEDED (${i * 5}s): please log in to DeepSeek in the opened Chrome window…`);
        dump(obs);
      }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    input = obs.elements.find((e) =>
      ["textbox", "searchbox", "combobox"].includes(e.role) &&
      /message|ask|chat|deepseek|send/i.test(e.name));
    if (!input) input = obs.elements.find((e) => ["textbox", "searchbox"].includes(e.role));
    if (input) break;
    if (i % 4 === 0) dump(obs);
    console.log(`waiting for chat input… (${i * 5}s) title=${obs.title}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!obs) throw new Error("no observation");
  dump(obs);
  if (!input) throw new Error("LOGIN_REQUIRED: no chat textbox appeared. Log in to DeepSeek in the opened window, then re-run.");

  console.log(`typing into [${input.role}] ${input.name}`);
  console.log(JSON.stringify(await page.type(input.ref, MESSAGE)));
  await new Promise((r) => setTimeout(r, 500));
  // Re-observe to get a fresh ref for the send button (typing may have stale-d the observation).
  const obs2 = await page.observe();
  const send = obs2.elements.find((e) =>
    e.role === "button" && /send|submit|arrow|enter/i.test(e.name));
  if (send) {
    console.log(`clicking send [${send.name}]`);
    console.log(JSON.stringify(await page.click(send.ref)));
  } else {
    console.log("no send button found, pressing Enter");
    console.log(JSON.stringify(await page.press("Enter")));
  }
  // Wait for the reply to stream in and stabilize.
  console.log("waiting for reply (text_stable)…");
  const w = await page.wait({ kind: "text_stable", stableForMs: 3000 }, { timeoutMs: 120_000 });
  console.log("stable:", JSON.stringify(w));
  const { text } = await page.extract();
  console.log("=== REPLY FULL TEXT START ===");
  console.log(text);
  console.log("=== REPLY FULL TEXT END ===");
  // Keep the window open briefly so you can see it.
  await new Promise((r) => setTimeout(r, 5000));
} finally {
  await browser.disconnect();
}
