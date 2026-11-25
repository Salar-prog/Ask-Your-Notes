# Notes Q&A

Ask questions about meeting notes you saved in the browser. The model sees the
notes and an optional live Wikipedia fact, and every figure and date it returns
is checked against those sources. A figure or date that is not in the notes or
the live fact is rejected before it reaches you; a name that is not there is
listed under the answer.

The claim is in [CLAIM.md](CLAIM.md). `node verify.mjs` proves it offline.

## Run

```bash
# from this directory
UPSTREAM=https://api.unorouter.com/v1 node serve.mjs
# open http://localhost:8080
```

Open **UnoRouter config**, set a model (for example `gpt-oss-120b:free`) and
your API key, then ask. The key stays in `localStorage` and is sent only to the
local proxy in `serve.mjs`; it is never written to this repo.

No key? The local reader still answers from the saved notes. That is the
fallback, not a degraded mode: the notes are the source either way.

Free models allow about one request per minute. The UI does not retry in a
loop; if the model is busy (`429`/`503`) the local reader answers and the
status line shows the fallback reason.

Find a model your key can use:

```bash
curl https://api.unorouter.com/v1/models \
  -H "Authorization: Bearer $UNOROUTER_API_KEY"
```

## Troubleshooting

**Open `http://localhost:8080`, not the `index.html` file.** A page opened as
`file://` cannot call the proxy, and Firefox logs a `file:///` security error.

**A `403` from `/proxy/chat/completions` is UnoRouter's status, not the local
server's.** Restart `serve.mjs` after updating it and read the terminal; the
proxy now prints the upstream body. The usual causes:

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
- summarising with no transcript says so.

No network and no API key are needed for the gate.

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
- **The key is in the browser.** Fine for a local demo; for a shared deployment,
  move the UnoRouter call behind a backend and keep the key in the environment.
- **Wikipedia only.** The live lookup is one REST call for a capitalised entity
  in the question. It is not a web search and it does not fetch arbitrary URLs.
- **No layout QA.** The verifier proves the script runs and the logic holds; it
  does not prove the page looks right in a browser.

`harness.mjs`, `serve.mjs`, and the starting structure come from the
MIT-licensed template in `../template/`.
