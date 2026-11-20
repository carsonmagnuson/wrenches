// End-to-end test with a mocked Datamuse API.
// Run: node synonymity/test/e2e.js   (needs Playwright + Chromium)
const { chromium } = require("playwright");
const path = require("path");
const assert = require("assert");

const PAGE = "file://" + path.resolve(__dirname, "../index.html");
const SYN = [
  { word: "glad", tags: ["f:40"] },
  { word: "jubilant", tags: ["f:0.8"] },
  { word: "blithe", tags: ["f:0.05"] },
  { word: "cheery", tags: ["f:2"] },
];
const ML = [{ word: "content", tags: ["f:60"] }, { word: "glad", tags: ["f:40"] }];

async function mock(page) {
  await page.route("https://api.datamuse.com/**", (r) => {
    const u = new URL(r.request().url());
    let body = [];
    if (u.searchParams.get("rel_syn")) body = SYN;
    else if (u.searchParams.get("ml")) body = ML;
    else if (u.searchParams.get("sp")) {
      const w = u.searchParams.get("sp");
      body = w === "zzqx" ? [] : [{ word: w }];
    }
    r.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  });
}

const ready = (p) => p.waitForFunction(() => document.getElementById("msg").textContent === "");
async function guess(p, w) {
  await p.fill("#guess", w);
  await p.click("#go");
  await p.waitForTimeout(120);
  return p.textContent("#msg");
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await mock(p);
  await p.goto(PAGE);

  // Scoring parity with roborean obscurity_of_fpm
  const obs = await p.evaluate(() => [40, 0.05, 0, 1e-9].map(__synonymity.obscurityOfFpm));
  assert.ok(Math.abs(obs[0] - (8 - Math.log10(40e3))) < 1e-9);
  assert.ok(Math.abs(obs[1] - 6.30103) < 1e-4);
  assert.strictEqual(obs[2], 11); // floored at 1e-6 fpm
  assert.strictEqual(obs[3], 11);

  // Daily is deterministic for a date
  const same = await p.evaluate(() => {
    const a = __synonymity.pickWords(__synonymity.mulberry32(__synonymity.seedFrom("2026-01-01")));
    const b = __synonymity.pickWords(__synonymity.mulberry32(__synonymity.seedFrom("2026-01-01")));
    return a.join() === b.join() && new Set(a).size === 7;
  });
  assert.ok(same, "daily words deterministic and unique");

  await ready(p);
  const prompt = (await p.textContent(".prompt")).trim();
  assert.match(await guess(p, "zzqx"), /isn't in the dictionary/);
  assert.match(await guess(p, prompt), /same word/);
  assert.match(await guess(p, "table"), /doesn't count/);
  assert.match(await p.textContent("#tries"), /2 tries/);
  assert.match(await guess(p, "blithe"), /accepted/);
  assert.match(await p.textContent("#after"), /\+63/);

  for (let i = 1; i < 7; i++) {
    await p.click("#next");
    await ready(p);
    await guess(p, i % 2 ? "content" : "glad");
  }
  await p.click("#next");
  const summary = await p.textContent("#stage");
  assert.match(summary, /213 points/);
  assert.match(summary, /Played/);
  assert.match(summary, /Next daily in/);

  // Reload restores finished daily and doesn't double-count stats
  await p.reload();
  await p.waitForSelector(".prompt");
  assert.match(await p.textContent(".prompt"), /213 points/);
  const st = await p.evaluate(() => JSON.parse(localStorage.getItem("synonymity:stats")));
  assert.strictEqual(st.played, 1);
  assert.strictEqual(st.best, 213);

  // Practice round: out of tries
  await p.click("#again");
  await ready(p);
  for (const w of ["table", "chair", "lamp"]) await guess(p, w);
  assert.match(await p.textContent("#msg"), /Out of tries/);
  assert.match(await p.textContent("#after"), /\+0/);

  if (process.env.SHOTS) {
    await p.setViewportSize({ width: 390, height: 844 });
    await p.screenshot({ path: path.join(process.env.SHOTS, "practice.png"), fullPage: true });
  }
  assert.deepStrictEqual(errors, []);
  await browser.close();
  console.log("all e2e checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
