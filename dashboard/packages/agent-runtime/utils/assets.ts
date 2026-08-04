import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log } from "./cli.ts";

// github image hosts that appear in issue/PR/review/comment markdown.
//  - github.com/user-attachments/assets/... and github.com/<owner>/<repo>/assets/...
//    are the raw urls present in *unrendered* bodies (the MCP tools return these);
//    fetching them needs the installation token.
//  - {private-user-images,user-images,camo}.githubusercontent.com/... are the signed
//    urls produced by body_html→turndown (see resolveBody); they self-authenticate via
//    a jwt/signature in the query string and must be fetched WITHOUT an Authorization
//    header (sending the token to the CDN would leak it).
const ASSET_HOST = String.raw`(?:github\.com\/(?:user-attachments\/assets|[^/\s]+\/[^/\s]+\/assets)\/|(?:private-user-images|user-images|camo)\.githubusercontent\.com\/)`;
const MARKDOWN_IMAGE = new RegExp(String.raw`!\[[^\]]*\]\((https:\/\/${ASSET_HOST}[^\s"')]+)`, "g");
const HTML_IMAGE = new RegExp(String.raw`<img[^>]+src=["'](https:\/\/${ASSET_HOST}[^"'\s]+)`, "g");

const ALLOWED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".gif",
  ".webp",
  ".svg",
  ".mp4",
  ".mov",
  ".webm",
]);

/**
 * downloads any github-hosted image/video assets referenced in `markdown` to
 * `<tmpdir>/assets` and rewrites the urls to the local file paths, so the agent can
 * read screenshots directly instead of relying on remote (often short-lived, signed)
 * urls. unique urls are downloaded once and every occurrence is rewritten. assets that
 * fail to download are left untouched.
 */
export async function downloadAssetsInMarkdown(
  markdown: string,
  tmpdir: string,
  githubToken: string
): Promise<string> {
  const urls = new Set<string>();
  for (const match of markdown.matchAll(MARKDOWN_IMAGE)) urls.add(match[1]);
  for (const match of markdown.matchAll(HTML_IMAGE)) urls.add(match[1]);

  if (urls.size === 0) return markdown;

  const assetsDir = path.join(tmpdir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  log.debug(`[assets] found ${urls.size} asset(s) to download`);

  let result = markdown;
  for (const url of urls) {
    const localPath = await downloadAsset(url, assetsDir, githubToken);
    if (localPath) result = result.replaceAll(url, localPath);
  }
  return result;
}

async function downloadAsset(
  url: string,
  assetsDir: string,
  githubToken: string
): Promise<string | null> {
  // only github.com itself needs the installation token; the githubusercontent CDN
  // urls carry their own signature. `redirect: "follow"` (undici default) strips the
  // Authorization header on cross-origin hops, so the token never reaches S3/the CDN.
  const needsAuth = new URL(url).hostname === "github.com";

  try {
    const res = await fetch(url, {
      headers: needsAuth ? { Authorization: `Bearer ${githubToken}` } : {},
    });
    if (!res.ok) {
      log.warning(`[assets] failed to download ${url}: ${res.status}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = resolveExtension(url, res.headers.get("content-type"));
    const filename = `${crypto.createHash("sha256").update(url).digest("hex").slice(0, 16)}${ext}`;
    const localPath = path.join(assetsDir, filename);
    fs.writeFileSync(localPath, buffer);
    log.debug(`[assets] downloaded ${url} to ${localPath}`);
    return localPath;
  } catch (e) {
    log.warning(`[assets] error downloading ${url}: ${e}`);
    return null;
  }
}

/** picks a safe, whitelisted file extension from the url path or response content-type. */
function resolveExtension(url: string, contentType: string | null): string {
  const fromPath = path.extname(new URL(url).pathname).toLowerCase();
  if (ALLOWED_EXTENSIONS.has(fromPath)) return fromPath;
  if (fromPath === ".jpeg") return ".jpg";

  const ct = contentType?.toLowerCase() ?? "";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("svg")) return ".svg";
  if (ct.includes("mp4")) return ".mp4";
  if (ct.includes("quicktime") || ct.includes("mov")) return ".mov";
  if (ct.includes("webm")) return ".webm";
  return ".png";
}
