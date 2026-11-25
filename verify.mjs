// The gate. Red until the claim in CLAIM.md is proven by the checks below.
//
// It boots the real page script under the stub DOM and drives the same
// functions the UI uses. No network: the model and Wikipedia calls are mocked,
// so the gate works offline and without an API key.
import { readFileSync } from "node:fs";
import { boot } from "./harness.mjs";

const failures = [];
let ran = 0;

function check(label, ok, detail = "") {
  ran++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures.push(label + (detail ? " — " + detail : ""));
}

function stop(message) {
  console.error("");
  console.error("FAIL: " + message);
  process.exit(1);
}

// ---------------------------------------------------------------- 1. the claim
let raw = "";
try {
  raw = readFileSync(new URL("./CLAIM.md", import.meta.url), "utf8");
} catch {
  stop("CLAIM.md is missing. Write one sentence — the thing this artifact must prove.");
}

const claim = raw.replace(/<!--[\s\S]*?-->/g, "").replace(/^#.*$/gm, "").trim();

if (!claim) {
  stop("CLAIM.md has no claim. Write one sentence — the thing this artifact must prove.");
}
if (claim.length < 20) {
  stop(`the claim is too short to mean anything: "${claim}"`);
}
console.log("claim  " + claim.replace(/\s+/g, " "));

// ---------------------------------------------------------------- 2. boot
console.log("\nboot");
const page = boot();
const app = page.globals.__app;
if (!app) stop("index.html did not expose window.__app");

const NOTE = "Acme Corp reported $2.3B revenue in Q3 2025, up 18% year over year. Their CFO said the renewal pipeline is strong. We agreed to send the security questionnaire by Friday.";
const TWO_SIDED = "I like the dark theme. I dislike the sidebar collapse.";
const NOISE = "Lunch was pizza with the design team.";
const TRANSCRIPT = [
  "Alice: We ship on 12 March 2026.",
  "Bob: I will own the launch checklist.",
  "Carol: Budget stays at $4,200."
].join("\n");

function useNotes(...texts) {
  app.clearNotes();
  for (const text of texts) app.addNote(text);
}

useNotes(NOTE);
check("the page boots with one saved note", app.getNotes().length === 1);

// A fetch stub that routes Wikipedia and the chat endpoint, and records the
// outgoing request so the checks can inspect what the model was actually sent.
function mockFetch({ answer, wiki = null, capture = {} }) {
  return async (url, init) => {
    if (String(url).includes("wikipedia.org")) {
      if (!wiki) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => wiki };
    }
    capture.url = String(url);
    capture.init = init;
    capture.body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: answer } }] }) };
  };
}

const CFG = { baseUrl: "http://test.local/proxy", model: "test-model", key: "test-secret-key-123" };

// ---------------------------------------------------------------- 3. the checks
const CHECKS = [
  ["the local reader answers from the note", async () => {
    useNotes(NOTE);
    const r = await app.answerQuestion("What did Acme report in Q3 2025?", null, { live: false });
    return r.source === "local" && r.text.includes("$2.3B")
      ? true
      : "got: " + r.text;
  }],

  // Only one of the question's two content words is in the sentence, and that
  // still clears the support threshold, so the note answers instead of abstaining.
  ["a partly-matching question still answers from the note", async () => {
    useNotes(NOTE);
    const r = await app.answerQuestion("What did Acme report?", null, { live: false });
    return r.text.includes("$2.3B") ? true : "got: " + r.text;
  }],

  ["the prompt carries the matching note, not the unrelated one, and not the key", async () => {
    useNotes(NOTE, NOISE);
    const question = "What did Acme report?";
    const hits = app.retrieve(app.getNotes(), question);
    if (!hits.length) return "retrieval found nothing";
    const msgs = app.buildMessages(hits, question, "");
    const system = msgs[0].content;
    const user = msgs[1].content;
    if (!user.includes("Acme Corp reported $2.3B revenue")) return "matching note missing from prompt";
    if (user.includes("pizza")) return "unrelated note leaked into the prompt";
    if (!user.includes(question)) return "question missing from prompt";
    if (!system.includes("ONLY")) return "prompt does not restrict the model";
    if (JSON.stringify(msgs).includes("test-secret-key-123")) return "key leaked into the prompt";
    return true;
  }],

  ["an invented figure is rejected and replaced", async () => {
    useNotes(NOTE);
    const cap = {};
    const r = await app.answerQuestion(
      "What did Acme report in Q3 2025?",
      CFG,
      { live: false, fetchImpl: mockFetch({ answer: "Acme reported $9.9B in Q3 2025.", capture: cap }) }
    );
    if (r.source !== "local") return "source was " + r.source;
    if (r.replaced !== true) return "answer was not replaced";
    if (!r.text.includes("$2.3B")) return "fallback did not cite the note: " + r.text;
    if (!r.bad.includes(9.9)) return "rejected figures: " + JSON.stringify(r.bad);
    if (cap.init.headers.Authorization !== "Bearer test-secret-key-123") return "auth header missing";
    if (cap.url !== "http://test.local/proxy/chat/completions") return "wrong URL: " + cap.url;
    return true;
  }],

  ["a grounded model answer passes the gate", async () => {
    useNotes(NOTE);
    const cap = {};
    const r = await app.answerQuestion(
      "What did Acme report in Q3 2025?",
      CFG,
      { live: false, fetchImpl: mockFetch({ answer: "Acme reported $2.3B in Q3 2025.", capture: cap }) }
    );
    if (r.source !== "api" || r.grounded !== true || !r.text.includes("$2.3B")) {
      return JSON.stringify({ source: r.source, grounded: r.grounded, text: r.text });
    }
    return r.weak === false ? true : "a grounded name was flagged: " + JSON.stringify(r.unknownNames);
  }],

  ["an invented date is blocked, not just its digits", async () => {
    useNotes(NOTE);
    const r = await app.answerQuestion(
      "What did Acme report in Q3 2025?",
      CFG,
      { live: false, fetchImpl: mockFetch({ answer: "Acme reported $2.3B in March 2025." }) }
    );
    if (r.source !== "local" || r.replaced !== true) {
      return JSON.stringify({ source: r.source, replaced: r.replaced, text: r.text });
    }
    if (!r.badDates || !r.badDates.some(d => d.includes("march"))) {
      return "blocked dates: " + JSON.stringify(r.badDates);
    }
    return true;
  }],

  ["a name absent from the notes is flagged weak, not blocked", async () => {
    useNotes(NOTE);
    const r = await app.answerQuestion(
      "What did Acme report in Q3 2025?",
      CFG,
      { live: false, fetchImpl: mockFetch({ answer: "Acme reported $2.3B in Q3 2025 after acquiring Zorbex." }) }
    );
    if (r.source !== "api" || r.grounded !== true) {
      return JSON.stringify({ source: r.source, grounded: r.grounded, text: r.text });
    }
    if (r.weak !== true) return "not flagged weak";
    if (!r.unknownNames || !r.unknownNames.some(n => n.toLowerCase() === "zorbex")) {
      return "names: " + JSON.stringify(r.unknownNames);
    }
    return true;
  }],

  ["a name from the note is not flagged", async () => {
    useNotes(NOTE);
    const r = await app.answerQuestion(
      "What did the CFO say?",
      CFG,
      { live: false, fetchImpl: mockFetch({ answer: "Acme's CFO said the renewal pipeline is strong." }) }
    );
    if (r.source !== "api") return "source: " + r.source;
    return r.weak === false && r.unknownNames && r.unknownNames.length === 0
      ? true
      : JSON.stringify({ weak: r.weak, names: r.unknownNames });
  }],

  ["a fetched live fact is allowed as a source", async () => {
    useNotes(NOTE);
    const cap = {};
    const r = await app.answerQuestion(
      "When was Acme founded?",
      CFG,
      {
        live: true,
        fetchImpl: mockFetch({
          answer: "Acme was founded in 1992.",
          capture: cap,
          wiki: {
            title: "Acme Corp",
            extract: "Acme Corp is a company founded in 1992.",
            content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Acme_Corp" } }
          }
        })
      }
    );
    if (r.source !== "api" || r.grounded !== true) return JSON.stringify({ source: r.source, grounded: r.grounded, bad: r.bad });
    if (!r.live || r.live.title !== "Acme Corp") return "live fact missing";
    if (!cap.body.messages[1].content.includes("1992")) return "live fact missing from prompt";
    return true;
  }],

  ["no note matches but a live fact does, so the model still answers", async () => {
    useNotes(NOISE);
    const r = await app.answerQuestion("When was Acme founded?", CFG, {
      live: true,
      fetchImpl: mockFetch({
        answer: "Acme was founded in 1992.",
        wiki: {
          title: "Acme Corp",
          extract: "Acme Corp is a company founded in 1992.",
          content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Acme_Corp" } }
        }
      })
    });
    if (r.source !== "api" || r.grounded !== true) return JSON.stringify({ source: r.source, grounded: r.grounded, text: r.text });
    if (r.notesRead !== 0) return "expected 0 notes read, got " + r.notesRead;
    return true;
  }],

  ["a two-sided note is answered with both sides, never one", async () => {
    useNotes(TWO_SIDED);
    const r = await app.answerQuestion("Do I like the dark theme or the sidebar collapse?", null, { live: false });
    if (!r.text.includes("dark theme")) return "missing the like side: " + r.text;
    if (!r.text.includes("sidebar collapse")) return "missing the dislike side: " + r.text;
    if (!/dislike/i.test(r.text)) return "missing the negative side: " + r.text;
    return true;
  }],

  ["an unrelated question abstains instead of guessing, without a model call", async () => {
    useNotes(NOTE);
    let called = false;
    const r = await app.answerQuestion("What is the marketing budget?", CFG, {
      live: false,
      fetchImpl: async () => { called = true; return { ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }) }; }
    });
    if (called) return "called the model with no evidence";
    return r.source === "local" && r.text === "Not in your notes."
      ? true
      : JSON.stringify({ source: r.source, text: r.text });
  }],

  ["a one-sided model answer to a contrast question is flagged", async () => {
    useNotes(TWO_SIDED);
    const question = "Do I like the dark theme or the sidebar collapse?";
    const one = await app.answerQuestion(question, CFG, {
      live: false,
      fetchImpl: mockFetch({ answer: "You like the dark theme." })
    });
    if (one.source !== "api") return "expected the api answer, got " + one.source + ": " + one.text;
    if (one.incomplete !== true) return "one-sided answer was not flagged";
    const both = await app.answerQuestion(question, CFG, {
      live: false,
      fetchImpl: mockFetch({ answer: "You like the dark theme but dislike the sidebar collapse." })
    });
    return both.incomplete === false ? true : "balanced answer was flagged";
  }],

  ["a transcript is stored separately from a note", async () => {
    useNotes(NOTE);
    app.addTranscript(TRANSCRIPT);
    const all = app.getNotes();
    const transcripts = all.filter(n => n.kind === "transcript");
    if (transcripts.length !== 1) return "transcripts: " + transcripts.length;
    if (!transcripts[0].text.includes("12 March 2026")) return "transcript text lost";
    return all.some(n => n.kind === "note") ? true : "the plain note lost its kind";
  }],

  ["a grounded summary passes and cites its segments", async () => {
    useNotes();
    app.addTranscript(TRANSCRIPT);
    const cap = {};
    const r = await app.summarize("", CFG, {
      fetchImpl: mockFetch({
        answer: "We ship on 12 March 2026 [1]. Bob owns the launch checklist [2]. Budget is $4,200 [3].",
        capture: cap
      })
    });
    if (r.source !== "api" || r.grounded !== true) {
      return JSON.stringify({ source: r.source, grounded: r.grounded, bad: r.bad, badDates: r.badDates });
    }
    if (!r.cited || r.cited.length !== 3) return "cited: " + JSON.stringify(r.cited && r.cited.map(s => s.n));
    if (!cap.body.messages[1].content.includes("[3] Carol")) return "numbered segments missing from the prompt";
    return true;
  }],

  ["a summary with an invented date is blocked", async () => {
    useNotes();
    app.addTranscript(TRANSCRIPT);
    const r = await app.summarize("", CFG, {
      fetchImpl: mockFetch({ answer: "We ship in March 2027 [1]." })
    });
    if (r.source !== "local" || r.replaced !== true) {
      return JSON.stringify({ source: r.source, replaced: r.replaced, text: r.text });
    }
    if (!r.badDates || !r.badDates.some(d => d.includes("march 2027"))) {
      return "dates: " + JSON.stringify(r.badDates);
    }
    return true;
  }],

  ["the local reader summarises transcript segments", async () => {
    useNotes();
    app.addTranscript(TRANSCRIPT);
    const r = await app.summarize("", null, {});
    if (r.source !== "local") return "source: " + r.source;
    if (!r.cited || r.cited.length !== 3) return "cited: " + JSON.stringify(r.cited && r.cited.map(s => s.n));
    if (!r.text.includes("12 March 2026")) return "summary missing the transcript line";
    return r.uncited === false ? true : "flagged uncited";
  }],

  ["the local summary answers a question from the transcript", async () => {
    useNotes();
    app.addTranscript(TRANSCRIPT);
    const r = await app.summarize("Who owns the checklist?", null, {});
    if (!r.text.includes("Bob")) return "got: " + r.text;
    if (!r.cited.some(s => s.text.includes("Bob"))) return "wrong citation";
    return true;
  }],

  ["the local summary abstains when the question is not in the transcript", async () => {
    useNotes();
    app.addTranscript(TRANSCRIPT);
    const r = await app.summarize("What is the pizza order?", null, {});
    return r.text === "Not in the transcript." && r.cited.length === 0
      ? true
      : JSON.stringify({ text: r.text, cited: r.cited.length });
  }],

  ["an out-of-range citation is ignored, not shown as a source", async () => {
    useNotes();
    app.addTranscript(TRANSCRIPT);
    const r = await app.summarize("", CFG, {
      fetchImpl: mockFetch({ answer: "We ship on 12 March 2026 [9]." })
    });
    if (r.source !== "api") return "source: " + r.source;
    if (r.cited.length !== 0) return "cited: " + JSON.stringify(r.cited.map(s => s.n));
    return r.uncited === true ? true : "not flagged uncited";
  }],

  ["summarise with no transcript says so", async () => {
    useNotes(NOTE);
    const r = await app.summarize("", null, {});
    return r.text === "Paste a transcript first." ? true : "got: " + r.text;
  }]
];

console.log("\nclaim");
for (const [label, fn] of CHECKS) {
  let ok = false;
  let detail = "";
  try {
    const result = await fn();
    ok = result === true;
    if (typeof result === "string") detail = result;
  } catch (e) {
    detail = e.message;
  }
  check(label, ok, detail);
}

// ---------------------------------------------------------------- 4. result
console.log("");
if (failures.length) {
  console.error(`${failures.length} failed of ${ran} checks:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`PASS ${ran} checks`);
