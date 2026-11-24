# Notes Q&A

Ask questions about meeting notes you saved in the browser. The model sees the
notes and an optional live Wikipedia fact, and every figure it returns is
checked against those sources. A figure that is not in the notes or the live
fact is rejected before it reaches you.

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

## What it does

1. Save a note (date-stamped, free text). Notes live in this browser under
   `notes-qa.notes.v1`.
2. Ask a question. The page picks the best-matching note sentence for the local
   reader, extracts a capitalised entity for the optional Wikipedia lookup, and
   sends the **whole notes list** plus the question to the model.
3. The answer is displayed with its source:
   - `UnoRouter` — the model answered.
   - `local reader` — no key, an API error, or a blocked figure.
   - `unsupported figure blocked` — the model cited a number absent from the
     notes/live fact, so its answer was replaced.
4. Every answer shows the nearest note sentence and the live fact, if one was
   fetched.

The prompt restricts the model to the notes and the live fact, but the prompt
is not the guarantee. The guarantee is the number gate: `unsupportedNumbers()`
extracts every number from the answer and requires it to exist in the sources.

## Verify

```bash
node verify.mjs
```

The gate boots the real page script under `harness.mjs`, mocks both the
Wikipedia call and the chat call, and checks:

- the local reader returns the note's `$2.3B`;
- the prompt contains the notes and question, and never the API key;
- `$9.9B` is rejected and replaced with `$2.3B`;
- a grounded `$2.3B` answer passes;
- a number that exists only in the fetched live fact is allowed.

No network and no API key are needed for the gate.

## Limits (read this before trusting it)

- **Figures only.** The gate checks numbers. The model can still invent a name
  or a relationship that has no number in it. Do not treat this as full
  fact-checking.
- **Literal figures.** A correct figure rewritten in another form
  (`$2.3B` → `2,300,000,000`) is rejected, because the gate compares numeric
  values, not units or formatting. The prompt asks the model to copy figures
  exactly.
- **Keyword retrieval.** `localAnswer()` scores sentences by word overlap. It is
  good for direct questions about a sentence, and weak for multi-hop questions
  ("who reported the figure the CFO mentioned?").
- **One browser.** Notes are in `localStorage`; there is no account, server
  storage, or sync. Clearing site data clears the notes.
- **The key is in the browser.** Fine for a local demo; for a shared deployment,
  move the UnoRouter call behind a backend and keep the key in the environment.
- **Wikipedia only.** The live lookup is one REST call for a capitalised entity
  in the question. It is not a web search and it does not fetch arbitrary URLs.
- **No layout QA.** The verifier proves the script runs and the logic holds; it
  does not prove the page looks right in a browser.

`harness.mjs`, `serve.mjs`, and the starting structure come from the
MIT-licensed template in `../template/`.
