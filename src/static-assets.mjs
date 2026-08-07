import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress } from "node:zlib";

const compress = promisify(brotliCompress);

export class StaticAssets {
  constructor(webDir) {
    this.assets = new Map([
      ["/", { file: path.join(webDir, "index.html"), type: "text/html; charset=utf-8" }],
      ["/index.html", { file: path.join(webDir, "index.html"), type: "text/html; charset=utf-8" }],
      ["/styles.css", { file: path.join(webDir, "styles.css"), type: "text/css; charset=utf-8" }],
      ["/catalog.js", { file: path.join(webDir, "catalog.js"), type: "text/javascript; charset=utf-8" }],
      ["/app.js", { file: path.join(webDir, "app.js"), type: "text/javascript; charset=utf-8" }],
      ["/vendor/lucide.js", { file: path.join(webDir, "lucide.js"), type: "text/javascript; charset=utf-8" }],
      ["/favicon.svg", { file: path.join(webDir, "favicon.svg"), type: "image/svg+xml" }],
    ]);
    this.cache = new Map();
  }

  async content(asset) {
    let cached = this.cache.get(asset.file);
    if (!cached) {
      const raw = await readFile(asset.file);
      cached = {
        raw,
        brotli: raw.length >= 1024 ? await compress(raw) : null,
      };
      this.cache.set(asset.file, cached);
    }
    return cached;
  }

  async serve(request, response, pathname) {
    const asset = this.assets.get(pathname);
    if (!asset) return false;
    try {
      const cached = await this.content(asset);
      const useBrotli = cached.brotli && /(?:^|,)\s*br\s*(?:,|$)/i.test(request.headers["accept-encoding"] ?? "");
      const body = useBrotli ? cached.brotli : cached.raw;
      response.writeHead(200, {
        "Content-Type": asset.type,
        "Content-Length": body.length,
        "Cache-Control": pathname.startsWith("/vendor/") ? "public, max-age=86400" : "no-cache",
        Vary: "Accept-Encoding",
        ...(useBrotli ? { "Content-Encoding": "br" } : {}),
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      const body = JSON.stringify({ error: "asset-not-found" });
      response.writeHead(404, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    }
    return true;
  }
}
