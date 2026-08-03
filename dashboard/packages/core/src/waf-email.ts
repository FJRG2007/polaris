/**
 * Email address obfuscation: the encoding, and the HTML rewrite that applies it.
 *
 * A harvester reading a page's source is looking for the one pattern that cannot be
 * disguised by wording. Replacing every address with a token the page decodes in the
 * browser removes it from the source without removing it from the page, which is the
 * whole trick.
 *
 * The encoding is single-byte XOR with the key carried as the first byte of the
 * token - deliberately the same scheme Cloudflare uses, so anything already written
 * against that format keeps working and nobody has to learn a second one. It is worth
 * being honest about what that buys: the key ships with the ciphertext, so it is
 * reversible by anyone who looks, and a scraper driving a headless browser decodes it
 * exactly like a visitor does. What it stops is the bulk harvester that reads source
 * and never runs JavaScript, which is most of them by volume. The UI says so rather
 * than implying a wall.
 *
 * The rewrite mirrors the same feature's documented boundaries, because they are the
 * ones that keep it from breaking working pages: HTML only, never inside a script,
 * style, template or textarea, never inside a comment, never in an attribute other
 * than an anchor's own `mailto:` href, and never at all between `<!--email_off-->`
 * markers.
 *
 * Pure and I/O-free so the guard can run it per response and a test can assert on it
 * with no DOM.
 */

/** Where an obfuscated anchor points. Not Cloudflare's `/cdn-cgi/` path: the format
 *  is shared, the origin is not, and a Polaris-served route claiming to be theirs
 *  would be a lie in the one place an operator goes to check what is happening. */
export const EMAIL_PROTECTION_PATH = "/polaris-shield/email-protection";

/** Where the decoder is served from. An external same-origin script rather than an
 *  inline one: a page with `script-src 'self'` accepts it, and an inline script is
 *  exactly what such a policy exists to refuse. */
export const EMAIL_DECODE_PATH = "/polaris-shield/email-decode.js";

/** The class the decoder looks for, on both the anchors and the spans. */
const MARKER_CLASS = "__polaris_email__";

/** The attribute holding the token on a rewritten span. */
const TOKEN_ATTRIBUTE = "data-pemail";

/**
 * Deliberately not an RFC-complete address grammar. This runs over every byte of
 * every HTML response, and the addresses worth hiding are the ones a harvester's own
 * pattern finds - which is this one. Being stricter than the harvester would leave
 * exactly the addresses it collects.
 */
const EMAIL_SOURCE = "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}";

/** Two compiled forms of one pattern. The global one carries `lastIndex` between
 *  calls, so testing with it would answer differently depending on what was scanned
 *  before - a stateful regex shared between a replace and a test is a bug waiting for
 *  the second caller. */
const EMAIL_PATTERN = new RegExp(EMAIL_SOURCE, "g");
const EMAIL_EXACT = new RegExp(`^${EMAIL_SOURCE}$`);

/** Regions whose contents are never text, so an address inside one is code or data
 *  and rewriting it would corrupt the page rather than protect anybody. */
const OPAQUE_TAGS = ["script", "style", "template", "textarea", "svg"];

/** The markers that switch the rewrite off for a region of the page, so an operator
 *  can keep one address readable (a support address a bot is welcome to). */
const OFF_OPEN = "<!--email_off-->";
const OFF_CLOSE = "<!--/email_off-->";

/** Encode one address as `<key><xor bytes>` in lowercase hex. The key is the first
 *  byte, which is what makes the token self-contained and the decoder stateless. */
export function encodeObfuscatedEmail(email: string, key: number): string {
    const byte = key & 0xff;
    let out = byte.toString(16).padStart(2, "0");
    // Encoded from UTF-8, not from code units: an internationalized address would
    // otherwise round-trip through the decoder as mojibake.
    for (const value of new TextEncoder().encode(email)) {
        out += ((value ^ byte) & 0xff).toString(16).padStart(2, "0");
    }
    return out;
}

/** Decode a token produced by `encodeObfuscatedEmail`. Exported for the tests and for
 *  anything server-side that needs to read a page back. Returns "" on a malformed
 *  token rather than throwing - it is parsing untrusted text. */
export function decodeObfuscatedEmail(token: string): string {
    if (token.length < 4 || token.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(token)) return "";
    const key = Number.parseInt(token.slice(0, 2), 16);
    const bytes = new Uint8Array((token.length - 2) / 2);
    for (let index = 2; index < token.length; index += 2) {
        bytes[(index - 2) / 2] = Number.parseInt(token.slice(index, index + 2), 16) ^ key;
    }
    return new TextDecoder().decode(bytes);
}

/** Escape a value for an HTML attribute or text node. */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export interface ObfuscateOptions {
    /** The XOR key. Injected so a test is deterministic; production passes a fresh
     *  random byte per response, which is what stops a token being a stable
     *  fingerprint of the address across pages. */
    readonly key: number;
}

/** What the rewrite did, so the caller can skip re-serializing a page it did not
 *  change and can decide whether the decoder script is even needed. */
export interface ObfuscateResult {
    readonly html: string;
    readonly replaced: number;
}

/**
 * Rewrite every exposed address in a chunk of HTML.
 *
 * Structured as one forward scan rather than a parse. A full parser would be correct
 * about markup this never touches, and would also mean re-serializing every response
 * through a DOM - which is a different order of cost on the request path and a
 * different class of bug when a page is not the well-formed HTML a parser assumes.
 * The scan only ever needs to know three things: where markup starts, where an opaque
 * region ends, and where the operator switched it off.
 */
export function obfuscateEmailsInHtml(html: string, options: ObfuscateOptions): ObfuscateResult {
    let out = "";
    let cursor = 0;
    let replaced = 0;

    while (cursor < html.length) {
        const next = html.indexOf("<", cursor);
        if (next < 0) {
            const tail = rewriteText(html.slice(cursor), options.key);
            out += tail.text;
            replaced += tail.replaced;
            break;
        }

        // Text before this markup is the only place a bare address is really text.
        const between = rewriteText(html.slice(cursor, next), options.key);
        out += between.text;
        replaced += between.replaced;

        if (html.startsWith(OFF_OPEN, next)) {
            // Everything up to the closing marker is the operator's explicit choice,
            // markers included: they are HTML comments, so leaving them in is inert
            // and stripping them would make the choice invisible in the source.
            const close = html.indexOf(OFF_CLOSE, next);
            const end = close < 0 ? html.length : close + OFF_CLOSE.length;
            out += html.slice(next, end);
            cursor = end;
            continue;
        }

        if (html.startsWith("<!--", next)) {
            const close = html.indexOf("-->", next);
            const end = close < 0 ? html.length : close + 3;
            out += html.slice(next, end);
            cursor = end;
            continue;
        }

        const tagEnd = html.indexOf(">", next);
        if (tagEnd < 0) {
            // Unterminated markup at the end of the chunk. Emitted as-is: guessing at
            // what it was is how a rewrite corrupts a page.
            out += html.slice(next);
            break;
        }

        const tag = html.slice(next, tagEnd + 1);
        const name = tagName(tag);
        if (name && OPAQUE_TAGS.includes(name) && !tag.endsWith("/>")) {
            const end = closingIndex(html, name, tagEnd + 1);
            out += html.slice(next, end);
            cursor = end;
            continue;
        }

        const anchor = rewriteMailtoHref(tag, options.key);
        out += anchor.tag;
        replaced += anchor.replaced;
        cursor = tagEnd + 1;
    }

    return { html: out, replaced };
}

/** The lowercased element name of an opening tag, or null when it is not one. */
function tagName(tag: string): string | null {
    const match = /^<\s*([A-Za-z][A-Za-z0-9-]*)/.exec(tag);
    return match ? match[1]!.toLowerCase() : null;
}

/** Index just past `</name>`, or the end of the string when it never closes. */
function closingIndex(html: string, name: string, from: number): number {
    const lower = html.toLowerCase();
    const close = lower.indexOf(`</${name}`, from);
    if (close < 0) return html.length;
    const end = html.indexOf(">", close);
    return end < 0 ? html.length : end + 1;
}

/** Replace bare addresses in a run of text with a span the decoder fills in. */
function rewriteText(text: string, key: number): { text: string; replaced: number } {
    if (!text.includes("@")) return { text, replaced: 0 };
    let replaced = 0;
    const out = text.replace(EMAIL_PATTERN, (email) => {
        replaced += 1;
        const token = encodeObfuscatedEmail(email, key);
        // The placeholder is what a visitor with JavaScript off is left with, so it
        // says what it is instead of showing a blank where an address was. The space
        // is non-breaking: it stands in for one word and must not wrap as two.
        return `<span class="${MARKER_CLASS}" ${TOKEN_ATTRIBUTE}="${token}">[email&#160;protected]</span>`;
    });
    return { text: out, replaced };
}

/** Rewrite an anchor's `mailto:` href, leaving every other tag and attribute alone. */
function rewriteMailtoHref(tag: string, key: number): { tag: string; replaced: number } {
    if (tagName(tag) !== "a") return { tag, replaced: 0 };
    const match = /\shref\s*=\s*("mailto:[^"]*"|'mailto:[^']*')/i.exec(tag);
    if (!match) return { tag, replaced: 0 };

    const quoted = match[1]!;
    const target = quoted.slice(1, -1).slice("mailto:".length);
    // A mailto can carry a subject and a body after `?`. Only the address is hidden;
    // the rest is put back by the decoder, so a "Contact us" link keeps its subject.
    const address = target.split("?")[0] ?? "";
    if (!EMAIL_EXACT.test(address)) return { tag, replaced: 0 };

    const token = encodeObfuscatedEmail(target, key);
    const href = `href="${EMAIL_PROTECTION_PATH}#${escapeHtml(token)}"`;
    const withHref = tag.slice(0, match.index + 1) + href + tag.slice(match.index + match[0].length);
    return { tag: withClass(withHref), replaced: 1 };
}

/** Add the marker class, merging into an existing class attribute rather than adding
 *  a second one - two class attributes is markup no browser agrees on. */
function withClass(tag: string): string {
    const existing = /\sclass\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    if (!existing) return `${tag.slice(0, tag.length - 1).replace(/\/$/, "")} class="${MARKER_CLASS}">`;
    const value = existing[2] ?? existing[3] ?? "";
    if (value.split(/\s+/).includes(MARKER_CLASS)) return tag;
    const replacement = ` class="${value === "" ? MARKER_CLASS : `${value} ${MARKER_CLASS}`}"`;
    return tag.slice(0, existing.index) + replacement + tag.slice(existing.index + existing[0].length);
}

/**
 * The decoder, as served at `EMAIL_DECODE_PATH`.
 *
 * Kept here beside the encoder rather than in a file of its own, because the two are
 * one format: a change to either that is not matched by the other produces a page
 * full of `[email protected]` and no error anywhere. Small enough to read in one go,
 * which is the other reason - this runs on every visitor's page.
 */
export const EMAIL_DECODE_SCRIPT = `(function(){
function d(t){var k=parseInt(t.substr(0,2),16),s="";for(var i=2;i<t.length;i+=2){s+="%"+("0"+(parseInt(t.substr(i,2),16)^k).toString(16)).slice(-2)}try{return decodeURIComponent(s)}catch(e){return ""}}
function run(){
var a=document.querySelectorAll('a.${MARKER_CLASS}[href*="${EMAIL_PROTECTION_PATH}#"]');
for(var i=0;i<a.length;i++){var h=a[i].getAttribute("href")||"";var t=h.slice(h.indexOf("#")+1);var v=d(t);if(v){a[i].setAttribute("href","mailto:"+v);a[i].className=a[i].className.replace("${MARKER_CLASS}","").trim()}}
var s=document.querySelectorAll('span.${MARKER_CLASS}[${TOKEN_ATTRIBUTE}]');
for(var j=0;j<s.length;j++){var v2=d(s[j].getAttribute("${TOKEN_ATTRIBUTE}")||"");if(v2){s[j].parentNode.replaceChild(document.createTextNode(v2),s[j])}}
}
if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",run)}else{run()}
})();`;
