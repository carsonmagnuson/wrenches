# Synonymity

A daily word game: you get seven prompt words and give a synonym for each. Rarer synonyms score more points.

- **Validation:** Datamuse `rel_syn` (true synonym, full points) and `ml` (close in meaning, half points). You get 3 tries per word. A word that isn't in the dictionary doesn't use up a try, and you can't answer with the prompt word or one of its forms.
- **Scoring:** the obscurity formula from [roborean](https://github.com/carsonmagnuson/roborean) (`services/obscurity/lib/obscurity.ml`), `8 − log10(fpm × 1e3)`, floored at 1e-6 fpm. Points are obscurity × 10.
- **After each word**, the game shows the rarest and most common synonyms with their obscurity, and how your answer ranks.
- **Modes:** *Daily* uses the same words for everyone, seeded by the date, and saves progress in localStorage. *Practice* picks random words.

It's a single static file that calls the Datamuse API (no key, CORS-enabled) from the browser. Open `index.html` directly or serve the folder:

```bash
python3 -m http.server -d synonymity 8000
```
