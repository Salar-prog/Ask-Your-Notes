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
app.clearNotes();
app.addNote(NOTE);
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
    const r = await app.answerQuestion("What did Acme report in Q3 2025?", null, { live: false });
    return r.source === "local" && r.text.includes("$2.3B")
      ? true
      : "got: " + r.text;
  }],

  ["the prompt carries the notes and the question, not the key", async () => {
    const msgs = app.buildMessages(app.getNotes(), "What did Acme report?", "");
    const system = msgs[0].content;
    const user = msgs[1].content;
    if (!user.includes(NOTE)) return "note missing from prompt";
    if (!user.includes("What did Acme report?")) return "question missing from prompt";
    if (!system.includes("ONLY")) return "prompt does not restrict the model";
    if (JSON.stringify(msgs).includes("test-secret-key-123")) return "key leaked into the prompt";
    return true;
  }],

  ["an invented figure is rejected and replaced", async () => {
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
    const cap = {};
    const r = await app.answerQuestion(
      "What did Acme report in Q3 2025?",
      CFG,
      { live: false, fetchImpl: mockFetch({ answer: "Acme reported $2.3B in Q3 2025.", capture: cap }) }
    );
    return r.source === "api" && r.grounded === true && r.text.includes("$2.3B")
      ? true
      : JSON.stringify({ source: r.source, grounded: r.grounded, text: r.text });
  }],

  ["a fetched live fact is allowed as a source", async () => {
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
