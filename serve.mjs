// Optional. Serves the folder and proxies to one fixed upstream, because most
// model endpoints (api.openai.com included) do not send CORS headers and a
// page cannot call them directly.
//
//   node serve.mjs
//   UPSTREAM=https://api.openai.com/v1 node serve.mjs
//
// Then point the app's base URL at http://localhost:8080/proxy
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const UPSTREAM = (process.env.UPSTREAM || "").replace(/\/+$/, "");

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

const readBody = req => new Promise((ok, no) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
  req.on("error", no);
});

createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type, authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    });
    return res.end();
  }

  // One destination, fixed at startup. Not an open proxy.
  if (req.method === "POST" && req.url.startsWith("/proxy")) {
    if (!UPSTREAM) {
      return send(res, 500, "Set UPSTREAM, e.g. UPSTREAM=https://api.openai.com/v1 node serve.mjs");
    }
    try {
      const upstream = await fetch(UPSTREAM + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {})
        },
        body: await readBody(req)
      });
      res.writeHead(upstream.status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      });
      return res.end(await upstream.text());
    } catch (e) {
      return send(res, 502, "upstream failed: " + e.message);
    }
  }

  const path = decodeURIComponent((req.url || "/").split("?")[0]);
  const file = normalize(join(ROOT, path === "/" ? "index.html" : path));
  if (!file.startsWith(ROOT)) return send(res, 403, "forbidden");

  try {
    const data = await readFile(file);
    send(res, 200, data, TYPES[extname(file)] || "application/octet-stream");
  } catch {
    send(res, 404, "not found");
  }
}).listen(PORT, () => {
  console.log("serving  http://localhost:" + PORT);
  console.log("proxy    " + (UPSTREAM ? UPSTREAM + "/chat/completions" : "off (set UPSTREAM)"));
});
