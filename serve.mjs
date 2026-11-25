// Static server and the only route to UnoRouter (`/proxy`), which sends no CORS
// headers. Holds the key when `.env` or the environment provides one.
//
//   node serve.mjs
//
// Configuration, from .env (gitignored) or the environment:
//   UNOROUTER_API_KEY   server-side key; the browser never sees it
//   UNOROUTER_BASE_URL  default https://api.unorouter.com/v1
//   UNOROUTER_MODEL     pins the model; the browser cannot change it
//   UPSTREAM            older name for UNOROUTER_BASE_URL
//   HOST / PORT         listen address, default 127.0.0.1:8080
//
// With no server key the page can still send one from its config panel.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 20;
const MAX_TOKENS = 400;
const TIMEOUT_MS = 25000;

function loadEnv(file) {
  try {
    const out = {};
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const ENV = { ...loadEnv(join(ROOT, ".env")), ...process.env };
const PORT = Number(ENV.PORT || 8080);
const HOST = ENV.HOST || "127.0.0.1";
const API_KEY = ENV.UNOROUTER_API_KEY || "";
const MODEL = ENV.UNOROUTER_MODEL || "";
const DEFAULT_UPSTREAM = (ENV.UNOROUTER_BASE_URL || ENV.UPSTREAM || "").replace(/\/+$/, "");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const send = (res, code, body, type = "text/plain; charset=utf-8") => {
  res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
  res.end(body);
};

const json = (res, code, body, headers = {}) => {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    ...headers
  });
  res.end(JSON.stringify(body));
};

const readBody = req => new Promise((ok, no) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
  req.on("error", no);
});

export function createHandler({ upstream = DEFAULT_UPSTREAM, key = API_KEY, model = MODEL } = {}) {
  const cache = new Map();
  const cooldown = new Map();

  return async function handler(req, res) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type, authorization",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
      });
      return res.end();
    }

    // Tells the page whether it should hide the key field. Never the key itself.
    if (req.method === "GET" && req.url.split("?")[0] === "/api/config") {
      return json(res, 200, { key: !!key, model: model || null });
    }

    // One destination, fixed at startup. Not an open proxy.
    if (req.method === "POST" && (req.url === "/proxy" || req.url.startsWith("/proxy/"))) {
      if (!upstream) {
        return json(res, 500, { error: { message: "Set UNOROUTER_BASE_URL (or UPSTREAM) on the server" } });
      }

      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: { message: "body is not JSON" } });
      }
      if (!payload || !Array.isArray(payload.messages)) {
        return json(res, 400, { error: { message: "messages must be an array" } });
      }
      if (model) payload.model = model;
      payload.max_tokens = Math.min(Number(payload.max_tokens) || 220, MAX_TOKENS);

      const auth = req.headers.authorization || (key ? "Bearer " + key : "");
      if (!auth) {
        return json(res, 401, { error: { message: "no API key: set UNOROUTER_API_KEY or use the key field" } });
      }

      const cacheKey = JSON.stringify([payload.model, payload.messages]);
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.at < CACHE_MS) {
        res.writeHead(hit.status, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "X-Cache": "hit"
        });
        return res.end(hit.body);
      }

      const until = cooldown.get(payload.model) || 0;
      if (Date.now() < until) {
        const wait = Math.max(1, Math.ceil((until - Date.now()) / 1000));
        return json(res, 429, {
          error: { message: "rate limited locally, retry in " + wait + "s", code: "local_cooldown" }
        }, { "Retry-After": String(wait) });
      }

      let upstreamRes;
      try {
        upstreamRes = await fetch(upstream + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TIMEOUT_MS)
        });
      } catch (e) {
        return json(res, 502, { error: { message: "upstream failed: " + e.message } });
      }

      const text = await upstreamRes.text();
      if (upstreamRes.status === 429) {
        const retry = Number(upstreamRes.headers.get("retry-after")) || 60;
        cooldown.set(payload.model, Date.now() + retry * 1000);
      }
      if (!upstreamRes.ok) {
        // The browser hides an error body behind the Network tab; the terminal
        // is the fast place to read UnoRouter's code and message.
        console.error("upstream " + upstreamRes.status + " " + upstreamRes.statusText);
        console.error(text.slice(0, 1200));
      }
      if (upstreamRes.ok) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, { status: upstreamRes.status, body: text, at: Date.now() });
      }
      res.writeHead(upstreamRes.status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      });
      return res.end(text);
    }

    const path = decodeURIComponent((req.url || "/").split("?")[0]);
    const file = normalize(join(ROOT, path === "/" ? "index.html" : path));
    if (!file.startsWith(ROOT)) return send(res, 403, "forbidden");
    // Only the demo's own files: a strict extension list keeps .env out.
    const type = TYPES[extname(file)];
    if (!type) return send(res, 404, "not found");

    try {
      const data = await readFile(file);
      send(res, 200, data, type);
    } catch {
      send(res, 404, "not found");
    }
  };
}

export function createApp(options) {
  return createServer(createHandler(options));
}

// Only listen when run directly, so verify.mjs can import the handler.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  createApp().listen(PORT, HOST, () => {
    console.log("serving  http://" + HOST + ":" + PORT);
    console.log("proxy    " + (DEFAULT_UPSTREAM ? DEFAULT_UPSTREAM + "/chat/completions" : "off (set UNOROUTER_BASE_URL)"));
    console.log("api key  " + (API_KEY ? "from .env, server-side" : "none on server (set UNOROUTER_API_KEY)"));
    if (MODEL) console.log("model    " + MODEL + " (pinned)");
  });
}
