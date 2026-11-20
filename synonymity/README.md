# Synonymity

A daily word game: you get seven prompt words and give a synonym for each. Rarer synonyms score more points.

## How it works

Each prompt word has a **curated answer list**, built offline by `tools/build-lists.mjs`:

1. **Claude generates** a broad list of acceptable single-word synonyms for every word in `data/prompts.txt`: everyday, formal, literary, archaic, slang. It tags each one `exact` or `close` and writes a short gloss saying which sense the list covers.
2. **Datamuse ranks** each candidate by corpus frequency. Words Datamuse doesn't recognize are dropped, which also filters out anything the model made up. The builder also removes derivatives of the prompt (happy → happily).
3. **Scoring** uses the obscurity formula from [roborean](https://github.com/carsonmagnuson/roborean) (`services/obscurity/lib/obscurity.ml`): `8 − log10(fpm × 1e3)`, floored at 1e-6 fpm. Points are obscurity × 10. An `exact` synonym gets full points and a `close` one gets half.

The game itself is a single static page (`index.html`) that loads `data/lists.js`. It makes no network calls while you play.

- **Tries:** 3 per word. Guessing the prompt word or one of its forms doesn't use one up. Simple inflections of a listed word are accepted (devoured → devour).
- **After each word**, the game shows the rarest and most common answers on the list and how yours ranks.
- **Modes:** *Daily* uses the same words for everyone, seeded by the date, and saves progress, stats and streak in localStorage. *Practice* picks random words.

## Building the lists

```bash
cd synonymity/tools && npm install && cd ..
export ANTHROPIC_API_KEY=...            # or any credential the Anthropic SDK picks up
node tools/build-lists.mjs              # generate missing lists, look up frequencies, write data/lists.{json,js}
node tools/build-lists.mjs --only happy,sad --force   # regenerate specific words
node tools/build-lists.mjs --rank-only  # re-rank from cached lists without calling Claude
```

Raw model output is cached in `data/raw/llm/<word>.json` and frequencies in `data/raw/freq.json`. Commit both so lists can be re-ranked or hand-edited without paying for generation again. To add prompt words, append them to `data/prompts.txt` and rerun the builder.

## Playing and testing

```bash
python3 -m http.server -d synonymity 8000   # or open index.html directly
node synonymity/test/e2e.js                 # Playwright + Chromium; uses fixture lists
```
