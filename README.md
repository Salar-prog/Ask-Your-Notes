# Ask Your Notes

Ask questions about meeting notes saved in the browser. Answers come from
UnoRouter, but every figure and date in them is checked against the notes (or a
fetched Wikipedia fact) first. An invented figure or date is replaced with the
note's own sentence; a name that is not in the sources is flagged under the
answer.

The one-sentence claim is in [CLAIM.md](CLAIM.md). `node verify.mjs` proves it
offline, with no key and no network.

## Run

Node 24, no install, no build.

```bash
cp .env.example .env    # UNOROUTER_API_KEY and UNOROUTER_MODEL
node serve.mjs          # http://127.0.0.1:8080
```

The key stays on the server. `serve.mjs` reads `.env` (gitignored) or the
environment, injects the `Authorization` header, pins `UNOROUTER_MODEL` for those
server-key requests, and answers `GET /api/config` with `{ key: true, model }` —
never the key. When it reports a key the page defaults to **server** config: the
base URL, model and key fields are hidden and calls go to `/proxy` with no key at
all.

The **Config source** toggle in **UnoRouter config** switches to **this browser**.
Type a base URL, model, and key; the page sends them and ignores the server key.
A request that carries its own key keeps its own model, even through `/proxy`; the
server only pins the model when it supplies the key. The values stay in
`localStorage` and go only to the base URL you typed — the local proxy, another
proxy, or a CORS-enabled OpenAI-compatible endpoint. Keep the default
`http://localhost:8080/proxy` to send the key only to this machine.
The **Debug** panel below the config shows the source, the key's location, the
base URL and model in use, the note count, and the last answer.

The server also keeps the free-tier limits from becoming a retry loop: a `429`
from UnoRouter starts a cooldown for that model and later requests get a local
`429` with `error.code: "local_cooldown"` and `Retry-After` until it expires.
Identical requests (same model and messages) are cached for 10 minutes and
answered with `X-Cache: hit`. Upstream calls time out after 25 seconds. It binds
`127.0.0.1` by default because it holds the key; set `HOST` to change that.

No key? The local reader still answers from the saved notes. That is the
fallback, not a degraded mode: the notes are the source either way. Free models
allow about one request per minute; the UI does not retry in a loop. If the model
is busy (`429`/`503`) the local reader answers and the status line shows the
fallback reason.

Find a model your key can use:

```bash
curl https://api.unorouter.com/v1/models \
  -H "Authorization: Bearer $UNOROUTER_API_KEY"
```

## Troubleshooting

**Open `http://localhost:8080`, not the `index.html` file.** A page opened as
`file://` cannot call the proxy, and Firefox logs a `file:///` security error.

**`empty response (finish_reason: length)`** means the model returned `200` but
spent the whole `max_tokens` budget on reasoning and had no text left. Reasoning
tokens share the budget. Use a non-reasoning free model (for example
`google/gemma-4-31b-it:free`) or one with a larger budget. `openrouter/free`
picks a free model at random, and most current free models reason by default, so
it is the common way to hit this.

**A `403` from `/proxy/chat/completions` is UnoRouter's status, not the local
server's.** Restart `serve.mjs` after updating it and read the terminal; the
proxy prints the upstream body. The usual causes:

- The key is the account **access token** from Settings, not the **API key**
  from the Tokens page. API keys start with `sk-`; access tokens are 29–32
  characters and cannot send completions.
- The model is not allowed for that key. `GET /v1/models` lists exactly what it
  can use.
- The model is not free. Its name must end in `:free`, or the key needs balance.
- The key has an IP allowlist that does not include the machine running
  `serve.mjs`.

Check the key directly:

```bash
curl https://api.unorouter.com/v1/models \
  -H "Authorization: Bearer $UNOROUTER_API_KEY"
```

`401` means missing/invalid/expired key; `403` means the key is valid but not
allowed to do this; `429` means wait for `Retry-After`; `503` with
`get_channel_failed` means the free providers are busy.

## What it does

1. Save a note (date-stamped, free text). Notes live in this browser under
   `notes-qa.notes.v1`.
2. Ask a question. `retrieve()` ranks the note sentences by how many of the
   question's content words they carry and keeps the top 5. Those sentences —
   not every note — go to the model, together with the question. The same
   sentences are the local reader's evidence, so the two paths see the same
   notes. A capitalised entity in the question is fetched from Wikipedia first.
3. If the best sentence matches less than half of the question's content words,
   the page answers `Not in your notes` instead of guessing. With no evidence
   and no live fact, it does not spend a model request at all.
4. If the evidence takes two sides of a contrast the question asks about (for
   example "do I like X or Y" where the note likes X and dislikes Y), both
   sentences are returned. If the model reports only one side anyway, the answer
   is shown with a `one side only` warning.
5. The answer is displayed with its source:
   - `UnoRouter` — the model answered.
   - `local reader` — no key, an API error, or a blocked figure/date.
   - `fallback: HTTP 400: …` — the provider's own error message after a rejected
     request, so a bad model ID or key is visible instead of a bare status.
   - `unsupported figure blocked` / `unsupported date blocked` — the model
     cited a number or date absent from the notes/live fact, so its answer was
     replaced with the note sentence.
   - `names not in notes: …` — the answer is kept, but a capitalised name was
     not found in the sources (amber border). It may still be right; the app
     only says what it cannot confirm.
6. Every answer shows how many notes were read, the evidence sentences, the
   live fact if one was fetched, and any name it could not confirm.
7. Paste a transcript in the Notes panel and press **Add transcript** — one
   speaker line per row. **Summarise** sends up to 40 numbered lines to the
   model and asks for at most three bullets, each ending with the line numbers
   it came from (`[2][5]`). The cited lines are shown under the summary. A
   figure or date in a summary is checked against the transcript exactly like a
   note answer; citation markers are removed before that check, so `[1]` is not
   read as the figure 1. A citation number outside the transcript is ignored,
   and a summary with no valid citations says `no segment citations`.

The prompt restricts the model to the notes and the live fact, but the prompt
is not the guarantee. The guarantee is the check on the text:
`unsupportedNumbers()` and `unsupportedDates()` extract every figure and date
phrase and require each to exist in the sources. `unknownNames()` does the same
for capitalised names, but only warns: a name can be correct general knowledge
the notes never mention.

## Verify

```bash
node verify.mjs
```

The gate boots the real page script under `harness.mjs`, mocks both the
Wikipedia call and the chat call, and checks:

- the local reader returns the note's `$2.3B`;
- the prompt carries the matching sentence, not an unrelated note, and never
  the API key;
- `$9.9B` is rejected and replaced with `$2.3B`;
- a grounded `$2.3B` answer passes;
- an invented date (`March 2025` against a note saying `Q3 2025`) is blocked
  even though its digits appear in the note;
- a name absent from the notes is flagged weak, not blocked;
- a name from the note is not flagged;
- a number that exists only in the fetched live fact is allowed;
- a two-sided note answers with both sides;
- an unrelated question abstains without calling the model;
- a one-sided model answer to a contrast question is flagged;
- a transcript is stored separately from a note;
- a grounded summary passes and cites its segments;
- a summary with an invented date is blocked;
- the local reader summarises and ranks transcript lines, and abstains on an
  unrelated question;
- a citation outside the transcript is ignored;
- summarising with no transcript says so;
- `/api/config` reports that a key exists without returning it;
- the server key answers a keyless request and pins the model and token cap;
- a client key through the proxy keeps its own model;
- an upstream `429` becomes a local cooldown with one upstream call, not two;
- an identical request is served from cache;
- `.env` is not served by the static file route;
- the page hides its key fields and sends no key when the server has one;
- the config toggle forces this browser's fields back on and ignores the server key.

No network and no API key are needed for the gate.

## Files

- `index.html` — the whole app: one page, one `<script>` block, no build.
- `verify.mjs` — the gate; every check drives the real page script.
- `harness.mjs` — the stub DOM that lets Node run that script.
- `serve.mjs` — static server, `/proxy`, server-side key, cache, cooldown.
- `CLAIM.md` — the one sentence the gate proves.

## Limits (read this before trusting it)

- **Not full fact-checking.** Figures and dates are blocked; names are only
  warned about. A relationship ("X owns Y"), a quotation, or a paraphrase can
  still be wrong with no figure, date, or new name in it.
- **Names are heuristic.** Only capitalised words after the first word of each
  sentence are checked: the first word is skipped because every sentence starts
  with a capital, so a name invented at the start of a sentence is missed.
  Matching is by word, so `Corp` in the notes does not cover `Corporation`.
- **Dates by words, not calendar.** A date passes when all of its words and
  numbers appear in the sources, so `12 March 2026` and `March 12, 2026` agree.
  A month name that is also an ordinary word (`may`) can hide an invented
  month.
- **Literal figures.** A correct figure rewritten in another form
  (`$2.3B` → `2,300,000,000`) is rejected, because the gate compares numeric
  values, not units or formatting. The prompt asks the model to copy figures
  exactly.
- **Keyword retrieval.** `retrieve()` scores sentences by word overlap — no
  stemming, embeddings, or synonyms. A question phrased with different words
  from the note will abstain (`Not in your notes`) even when the answer is
  there. Good for direct questions, weak for multi-hop ("who reported the figure
  the CFO mentioned?").
- **Half-match threshold.** A sentence must share at least half of the
  question's content words. That is what makes abstention possible, but it is a
  blunt cut: a long question about a short sentence can miss.
- **Two-sided detection is a small word list.** `like`/`dislike`,
  `agree`/`disagree`, and a few synonyms. "I prefer X" vs "X is fine" is not
  detected as a contradiction; the note still answers, but the one-side warning
  may not fire.
- **Summaries truncate.** Only the first 40 transcript lines are sent, so a long
  meeting is summarised from its opening. Add a second transcript for later
  parts, or raise `SEGMENTS` (and the token budget) when needed.
- **Citations are a prompt contract.** The model is asked to end each bullet
  with `[n]`. If it ignores that, the answer is still shown but marked
  `no segment citations`; the app does not guess which line was meant.
- **One browser.** Notes and transcripts are in `localStorage`; there is no
  account, server storage, or sync. Clearing site data clears them.
- **The proxy is a demo server.** The cache and cooldown live in one process's
  memory: restarting forgets them, and each process has its own. The cache is
  keyed by model and messages, so a changed note set is a fresh request. There
  is no user auth: anyone who can reach the port can ask through the server key,
  which is why it binds `127.0.0.1` by default.
- **The key is only as private as the mode.** With `UNOROUTER_API_KEY` on the
  server it never reaches the browser. Without it the page keeps the key in
  `localStorage` and sends it through the local proxy: fine for a local demo,
  not for a shared deployment.
- **Wikipedia only.** The live lookup is one REST call for a capitalised entity
  in the question. It is not a web search and it does not fetch arbitrary URLs.
- **Light visual QA only.** The verifier proves the script runs and the logic
  holds; it does not prove the layout. This design was checked with headless
  Chrome screenshots at 1440px and 390px, empty and answered. Firefox, Safari,
  and a real keyboard or screen-reader pass were not run.

`harness.mjs`, `serve.mjs`, and the page structure started from a small
MIT-licensed static-page template.
