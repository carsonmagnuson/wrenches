// End-to-end test. Serves the game with a fixture in place of data/lists.js.
// Run: node synonymity/test/e2e.js   (needs Playwright + Chromium)
const { chromium } = require("playwright");
const path = require("path");
const http = require("http");
const fs = require("fs");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const answers = [
  { w: "blithe", o: 6.3, k: "e" },
  { w: "jubilant", o: 5.1, k: "e" },
  { w: "devour", o: 4.6, k: "e" },
  { w: "glad", o: 3.4, k: "e" },
  { w: "content", o: 3.22, k: "c" },
];
const PROMPTS = ["happy", "sad", "eat", "angry", "big", "small", "fast", "slow", "brave", "calm"];
const FIXTURE = {
  version: 1,
  lists: Object.fromEntries(PROMPTS.map((p) => [p, { gloss: `adj. test sense of ${p}`, answers }])),
};

// Serves index.html from disk and the fixture in place of data/lists.js.
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = req.url.split("?")[0];
      if (url === "/data/lists.js") {
        res.setHeader("content-type", "text/javascript");
        return res.end(`window.SYNONYMITY_LISTS = ${JSON.stringify(FIXTURE)};`);
      }
      if (url !== "/" && url !== "/index.html") { res.statusCode = 404; return res.end(); }
      res.setHeader("content-type", "text/html");
      fs.createReadStream(path.join(ROOT, "index.html")).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
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
  const srv = await serve();
  const browser = await chromium.launch();
  const p = await (await browser.newContext()).newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${srv.address().port}/`);

  // Scoring parity with roborean obscurity_of_fpm
  const obs = await p.evaluate(() => [40, 0.05, 0, 1e-9].map(__synonymity.obscurityOfFpm));
  assert.ok(Math.abs(obs[0] - (8 - Math.log10(40e3))) < 1e-9);
  assert.ok(Math.abs(obs[1] - 6.30103) < 1e-4);
  assert.strictEqual(obs[2], 11); // floored at 1e-6 fpm
  assert.strictEqual(obs[3], 11);

  // Daily is deterministic for a date and drawn from the lists
  const daily = await p.evaluate(() => {
    const pick = () => __synonymity.pickWords(__synonymity.mulberry32(__synonymity.seedFrom("2026-01-01")));
    const a = pick(), b = pick();
    return { same: a.join() === b.join(), unique: new Set(a).size, inPool: a.every((w) => __synonymity.POOL.includes(w)) };
  });
  assert.deepStrictEqual(daily, { same: true, unique: 7, inPool: true });

  await ready(p);
  const prompt = (await p.textContent(".prompt")).trim();
  assert.match(await p.textContent(".gloss"), new RegExp(`test sense of ${prompt}`));
  assert.match(await guess(p, prompt), /same word/);
  assert.match(await guess(p, "table"), /isn't on the list/);
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
  assert.match(summary, /213 points/); // 63 + 3×16 (close, half) + 3×34
  assert.match(summary, /Played/);
  assert.match(summary, /Next daily in/);

  // Reload restores the finished daily and doesn't double-count stats
  await p.reload();
  await p.waitForSelector(".prompt");
  assert.match(await p.textContent(".prompt"), /213 points/);
  const st = await p.evaluate(() => JSON.parse(localStorage.getItem("synonymity:stats")));
  assert.strictEqual(st.played, 1);
  assert.strictEqual(st.best, 213);

  // Inflected guesses match the base form on the list
  await p.click("#again");
  await ready(p);
  assert.match(await guess(p, "devoured"), /accepted/);
  assert.match(await p.textContent("#after"), /\+46/);

  // Out of tries
  await p.click("#next");
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
  srv.close();
  console.log("all e2e checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
