#!/usr/bin/env node
// Builds Synonymity's curated answer lists.
//
//   1. Claude generates a broad list of acceptable single-word synonyms for each
//      prompt word in data/prompts.txt (cached in data/raw/llm/<word>.json).
//   2. Datamuse gives each candidate a corpus frequency (cached in
//      data/raw/freq.json). Words Datamuse doesn't know are dropped.
//   3. Each word is scored with roborean's obscurity formula and the lists are
//      written to data/lists.json and data/lists.js (the game loads the .js).
//
// Usage:
//   node tools/build-lists.mjs                 # generate missing lists, then rank all
//   node tools/build-lists.mjs --only happy,sad
//   node tools/build-lists.mjs --force         # regenerate LLM lists even if cached
//   node tools/build-lists.mjs --rank-only     # skip Claude, re-rank from cached lists
//
// Env: ANTHROPIC_API_KEY (or another credential the SDK picks up),
//      DATAMUSE_URL (default https://api.datamuse.com), CONCURRENCY (default 4).

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const RAW_LLM = path.join(DATA, "raw", "llm");
const FREQ_CACHE = path.join(DATA, "raw", "freq.json");
const DATAMUSE = process.env.DATAMUSE_URL ?? "https://api.datamuse.com";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);
const MODEL = "claude-opus-5-5";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// ---- Scoring: port of roborean services/obscurity/lib/obscurity.ml ----
const MIN_FPM = 1e-6;
export function obscurityOfFpm(f) {
  const v = typeof f === "number" && f >= MIN_FPM ? f : MIN_FPM;
  return 8 - Math.log10(v * 1e3);
}

// ---- Helpers ----
const isWord = (w) => /^[a-z][a-z'-]*[a-z]$/.test(w);
// happy -> happily/happiness, sad -> sadly/sadden: derivatives aren't fair answers.
export function isDerivative(w, prompt) {
  const stem = prompt.replace(/(e|y)$/, "");
  return stem.length >= 3 && w !== prompt && w.startsWith(stem) && w.length - prompt.length <= 5;
}
const readJson = async (p, fallback) => {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; }
};
const writeJson = (p, v) => fs.writeFile(p, JSON.stringify(v, null, 2) + "\n");

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function loadPrompts() {
  const text = await fs.readFile(path.join(DATA, "prompts.txt"), "utf8");
  const words = text.split("\n").map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith("#"));
  return [...new Set(words)];
}

// ---- Step 1: Claude ----
const SCHEMA = {
  type: "object",
  properties: {
    gloss: {
      type: "string",
      description: "Part of speech and the sense(s) covered, under 60 characters, e.g. 'adj. feeling or showing pleasure'",
    },
    synonyms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: { type: "string" },
          fit: { type: "string", enum: ["exact", "close"] },
        },
        required: ["word", "fit"],
        additionalProperties: false,
      },
    },
  },
  required: ["gloss", "synonyms"],
  additionalProperties: false,
};

const SYSTEM = `You build answer lists for a word game. A player sees a prompt word and must type one synonym; rarer accepted synonyms score more points. Your list is the answer key, so it must be broad (players will try obscure words) and fair (every listed word must be defensible).

Rules for the list:
- Single words only, lowercase, base form (no phrases, no hyphenated compounds unless that is the standard spelling).
- Include every reasonable synonym across the word's common senses: everyday words, formal, literary, archaic, technical, slang and regional words all count if a good dictionary or thesaurus would support them.
- Mark "exact" when the word can replace the prompt word in a typical sentence with little change of meaning. Mark "close" when it overlaps strongly in one sense but is narrower, broader, or shifts the tone.
- Exclude: the prompt word itself and its inflections or derivatives (happy -> happily, happiness), antonyms, loosely associated words (happy -> smile), and words whose only link is a very rare sense of the prompt.
- Aim for 60 to 200 words. Do not pad with weak matches to reach a count.
- The gloss names the part of speech and the senses your list covers, so the player knows which meaning to aim for.`;

async function generate(client, word) {
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: `Prompt word: ${word}` }],
  });
  if (res.stop_reason === "refusal") throw new Error(`refused (${res.stop_details?.category ?? "unknown"})`);
  if (res.stop_reason === "max_tokens") throw new Error("hit max_tokens");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = JSON.parse(text);
  return { word, model: res.model, generatedAt: new Date().toISOString(), ...parsed };
}

// ---- Step 2: Datamuse frequency ----
async function fetchFreq(word) {
  const url = `${DATAMUSE}/words?sp=${encodeURIComponent(word)}&md=f&max=1`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const e = body[0];
      if (!e || e.word.toLowerCase() !== word) return null; // unknown to Datamuse
      const tag = (e.tags ?? []).find((t) => t.startsWith("f:"));
      return tag ? Number(tag.slice(2)) : MIN_FPM;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

// ---- Main ----
async function main() {
  await fs.mkdir(RAW_LLM, { recursive: true });
  let prompts = await loadPrompts();
  const only = opt("--only");
  if (only) prompts = only.split(",").map((w) => w.trim().toLowerCase());

  // Step 1
  if (!flag("--rank-only")) {
    const todo = [];
    for (const w of prompts) {
      const exists = await readJson(path.join(RAW_LLM, `${w}.json`), null);
      if (!exists || flag("--force")) todo.push(w);
    }
    if (todo.length) {
      const client = new Anthropic();
      console.log(`Generating ${todo.length} list(s) with ${MODEL}…`);
      await pool(todo, CONCURRENCY, async (w) => {
        try {
          const out = await generate(client, w);
          await writeJson(path.join(RAW_LLM, `${w}.json`), out);
          console.log(`  ${w}: ${out.synonyms.length} candidates`);
        } catch (err) {
          console.error(`  ${w}: FAILED ${err.message}`);
        }
      });
    }
  }

  // Step 2
  const freq = await readJson(FREQ_CACHE, {});
  const raws = {};
  const allPrompts = await loadPrompts();
  for (const w of allPrompts) {
    const r = await readJson(path.join(RAW_LLM, `${w}.json`), null);
    if (r) raws[w] = r;
  }
  const needed = new Set();
  for (const r of Object.values(raws)) {
    for (const s of r.synonyms) {
      const w = s.word.trim().toLowerCase();
      if (isWord(w) && !(w in freq)) needed.add(w);
    }
  }
  if (needed.size) {
    console.log(`Looking up ${needed.size} frequencies on Datamuse…`);
    let done = 0;
    await pool([...needed], CONCURRENCY * 2, async (w) => {
      try { freq[w] = await fetchFreq(w); } catch (err) { console.error(`  ${w}: ${err.message}`); }
      if (++done % 200 === 0) { console.log(`  ${done}/${needed.size}`); await writeJson(FREQ_CACHE, freq); }
    });
    await writeJson(FREQ_CACHE, freq);
  }

  // Step 3
  const lists = {};
  const report = [];
  for (const [prompt, r] of Object.entries(raws)) {
    const seen = new Map();
    let dropped = 0;
    for (const s of r.synonyms) {
      const w = s.word.trim().toLowerCase();
      if (!isWord(w) || w === prompt || isDerivative(w, prompt)) { dropped++; continue; }
      if (!(w in freq) || freq[w] === null) { dropped++; continue; }
      const prev = seen.get(w);
      if (prev && prev.k === "e") continue;
      seen.set(w, { w, o: Math.round(obscurityOfFpm(freq[w]) * 100) / 100, k: s.fit === "exact" ? "e" : "c" });
    }
    const answers = [...seen.values()].sort((a, b) => b.o - a.o);
    if (answers.length < 8) { report.push(`${prompt}: only ${answers.length} answers, skipped`); continue; }
    lists[prompt] = { gloss: r.gloss, answers };
    report.push(`${prompt}: ${answers.length} answers (${dropped} dropped)`);
  }

  const out = { version: 1, model: MODEL, builtAt: new Date().toISOString(), lists };
  await writeJson(path.join(DATA, "lists.json"), out);
  await fs.writeFile(
    path.join(DATA, "lists.js"),
    `// Generated by tools/build-lists.mjs. Do not edit by hand.\nwindow.SYNONYMITY_LISTS = ${JSON.stringify(out)};\n`,
  );
  console.log(report.join("\n"));
  console.log(`Wrote ${Object.keys(lists).length} lists to data/lists.json and data/lists.js`);
}

main().catch((err) => { console.error(err); process.exit(1); });
