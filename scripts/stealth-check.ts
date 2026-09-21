// Stealth regression: re-run on every Chrome bump. Bounded goal — normal-sites hygiene.
// Checks the MAIN-world JS surface (what detectors see) + a real search round trip.
// Run: npx tsx scripts/stealth-check.ts
import { BrowserRuntime } from "../src/index.js";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`);
  if (!ok) failures++;
};

const browser = await BrowserRuntime.connect({
  mode: "managed", // Chrome auto-detected
  headless: true,
  viewport: { width: 1366, height: 768 },
});
try {
  const page = await browser.createPage("https://bot.sannysoft.com/");
  await page.wait({ kind: "text_present", text: "Browser" }, { timeoutMs: 20000 }).catch(() => {});
  // Main-world probes — page.evaluate runs in page context, exactly what detectors read.
  // NOTE: read instance properties (navigator.webdriver), never prototype getters
  // (native getters throw Illegal invocation off-prototype — probe artifact, not a tell).
  const probes = await page.evaluate<Record<string, string>>(`(() => {
    const safe = (fn) => { try { return String(fn()); } catch (e) { return 'threw:' + e.name; } };
    return {
      webdriver: safe(() => navigator.webdriver),
      webdriverDesc: safe(() => Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver').get.toString().slice(0, 40)),
      plugins: safe(() => navigator.plugins?.length ?? 0),
      languages: safe(() => JSON.stringify(navigator.languages)),
      vendor: safe(() => navigator.vendor),
      chrome: safe(() => typeof window.chrome),
      chromeRuntime: safe(() => typeof window.chrome?.runtime),
      outer: safe(() => window.outerWidth + 'x' + window.outerHeight),
      ua: safe(() => navigator.userAgent),
      hw: safe(() => navigator.hardwareConcurrency),
    };
  })()`);
  console.log(probes);
  check("webdriver false (like real Chrome)", probes.webdriver === "false", probes.webdriver);
  check("webdriver getter native", (probes.webdriverDesc ?? "").includes("[native code]"), probes.webdriverDesc);
  check("plugins populated", Number(probes.plugins) > 0, probes.plugins);
  check("languages set", (probes.languages ?? "").includes("en"), probes.languages);
  check("vendor Google", (probes.vendor ?? "").includes("Google"), probes.vendor);
  check("window.chrome present", probes.chrome === "object", probes.chrome);
  check("chrome.runtime present", probes.chromeRuntime === "object", probes.chromeRuntime);
  check("outer dims non-zero", !(probes.outer ?? "").startsWith("0x"), probes.outer);
  check("no HeadlessChrome UA", !(probes.ua ?? "").includes("HeadlessChrome"), (probes.ua ?? "").slice(0, 100));

  // Sannysoft table: fetch rows that mention failures (with context).
  const { text } = await page.extract();
  const lines = text.split("\n");
  const fails: string[] = [];
  lines.forEach((l, i) => {
    if (/failed|bot detected/i.test(l)) fails.push(`[${lines[i - 1] ?? ""} | ${l} | ${lines[i + 1] ?? ""}]`);
  });
  console.log("sannysoft fail rows:", JSON.stringify(fails.slice(0, 5)));
  check("sannysoft no failure rows", fails.length === 0, fails.slice(0, 3).join(" | "));

  // Real search round trip (the web_search harness's bread and butter).
  // Human pattern: homepage → type into the box → submit. Direct /search URL
  // navigation from a zero-history profile is itself bot-shaped; don't measure that.
  await page.navigate("https://www.google.com/");
  await page.wait({ kind: "text_stable", stableForMs: 800 }, { timeoutMs: 20000 }).catch(() => {});
  let obs = await page.observe({ profile: "agent", maxTokens: 3000 });
  // Google consent interstitial ("Before you continue") is normal friction, not a bot block:
  // accept once like a human would, then continue.
  if (/before you continue/i.test(obs.text)) {
    const accept = obs.elements.find((e) => e.role === "button" && /accept|agree/i.test(e.name));
    if (accept) {
      console.log("accepting google consent…");
      await page.click(accept.ref);
      await page.wait({ kind: "text_stable", stableForMs: 800 }, { timeoutMs: 20000 }).catch(() => {});
      obs = await page.observe({ profile: "agent", maxTokens: 3000 });
    }
  }
  const box = obs.elements.find((e) => ["textbox", "searchbox", "combobox"].includes(e.role));
  if (!box) {
    check("google search box present", false, obs.text.slice(0, 120));
  } else {
    await page.type(box.ref, "runtime verification browser automation");
    await page.press("Enter");
    await page.wait({ kind: "text_stable", stableForMs: 1000 }, { timeoutMs: 25000 }).catch(() => {});
    obs = await page.observe({ profile: "agent", maxTokens: 3000 });
  }
  const blocked = /unusual traffic|captcha|not a robot|before you continue/i.test(obs.text);
  const links = obs.elements.filter((e) => e.role === "link").length;
  check("google not bot-blocked", !blocked, obs.text.slice(0, 120));
  check("google result links observed", links > 0, `${links} links`);
} catch (e) {
  failures++;
  console.error("HARNESS ERROR", e);
} finally {
  await browser.disconnect();
}
console.log(failures === 0 ? "STEALTH ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
