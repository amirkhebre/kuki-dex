import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "web");
const port = Number(process.env.PORT ?? 8765);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const raw = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const rel = raw === "/" || raw === "\\" ? "index.html" : raw.replace(/^[/\\]+/, "");
    const file = join(root, rel);
    if (!file.startsWith(root)) throw new Error("forbidden");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`KUKI DEX UI: http://127.0.0.1:${port}`));
