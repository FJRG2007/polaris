/**
 * SQL injection and cross-site scripting signatures in a request line.
 *
 * The rule packs ask what a request wanted and the integrity check asks whether the
 * client is what it says it is. This asks a third thing: whether the request is
 * carrying an attack in its own URL. `/product?id=1' OR 1=1--` is a legitimate path
 * with a payload glued to it, so no path list and no user-agent list can see it.
 *
 * Three properties matter more than breadth here, in this order:
 *
 *  - It costs nothing. One pass over the request line, no allocation at all for the
 *    overwhelming majority of requests (see `suspicious`), and a decode only for the
 *    ones that could be hiding something. It runs inside the co-located guard on a
 *    check Traefik was already making, so what it adds is microseconds of CPU rather
 *    than a hop.
 *  - It does not fire on real traffic. Every signature below either cannot occur in
 *    an honest URL or occurs only in one an operator can carve out with an `allow`
 *    rule above it. Where a broader pattern would catch more attacks and also catch
 *    a working site, the narrower one is written instead - a control that blocks a
 *    real visitor gets switched off entirely, taking its true positives with it.
 *  - It cannot be walked past with an encoder. Percent-encoding, double
 *    percent-encoding, `+` for space, mixed case and an inline SQL comment between
 *    two keywords are all normalized away before anything is matched.
 *
 * What it does NOT see is the request body: Traefik's forwardAuth forwards the
 * headers and not the payload, so a POST carrying the same string is invisible here.
 * That is a property of where this runs, not an oversight - the alternative is
 * putting the guard in the data path of every route to read every upload.
 *
 * Pure and I/O-free like the rest of the guard's decision path.
 */

/** The parts of a request this reads. All are attacker-controlled and all are seen in
 *  full by the forwardAuth check. */
export interface WafInjectionRequest {
    readonly path?: string | null;
    readonly query?: string | null;
    readonly userAgent?: string | null;
}

/**
 * Characters without which neither class of payload can be written, indexed by code.
 *
 * This is the whole reason the check is free: a request line that holds none of them
 * is answered in one pass with no decode, no lowercase and no allocation, and that is
 * what nearly every real request looks like - `/api/users/42`, `/assets/app.9f3c.css`,
 * `/blog/why-we-moved?page=2`.
 *
 * Each entry earns its place. SQL needs its keywords separated, so it needs a space,
 * a `+`, a `%` or a comment (`*`). XSS needs a tag (`<`), a scheme (`:`) or a call
 * (`(`). Quotes break out of a value, `;` starts a second statement, and `%` hides
 * any of them from a reader. `-` is deliberately absent: it is in half the URLs on the
 * internet, and the one signature that uses it (`--`) also needs a quote.
 */
const SUSPECT = new Uint8Array(128);
for (const char of " \"%'()*+:;<>\\`|") SUSPECT[char.charCodeAt(0)] = 1;

/**
 * The same question for a header, which is a stricter one.
 *
 * A browser's user agent is made of spaces, brackets, semicolons and colons, so the
 * gate above lets every request in the world past and the check ends up scanning a
 * hundred bytes of `Mozilla/5.0 ...` on every single request - the one part of this
 * that would cost real time.
 *
 * It is also the wrong question to ask of a header. A URL is a value the application
 * parses, re-decodes and hands around, so anything can hide in one; a header is a raw
 * string that gets embedded somewhere - a log insert, an admin page listing agents -
 * and an attack embedded in a quoted context has to break out of it first. So a header
 * is only worth scanning when it carries something that could: a quote, an angle
 * bracket, an escape, an encoding. `sqlmap' union select` still gets read; Chrome's
 * user agent is answered in one pass with nothing allocated.
 */
const SUSPECT_HEADER = new Uint8Array(128);
for (const char of "\"%'*<>\\`|") SUSPECT_HEADER[char.charCodeAt(0)] = 1;

/** Characters that make up a keyword. The text is lowercased before it is scanned, so
 *  only the lower half is marked. `_` is in, because `information_schema` and
 *  `pg_sleep` are one word each. */
const WORD = new Uint8Array(128);
for (let code = 97; code <= 122; code += 1) WORD[code] = 1;
for (let code = 48; code <= 57; code += 1) WORD[code] = 1;
WORD[95] = 1;

/** Keywords whose presence is the whole signature - no context makes any of these
 *  part of an honest URL. */
const SQL_MARKERS = new Set(["information_schema", "sysobjects", "syscolumns", "xp_cmdshell", "pg_sleep"]);

/** Functions an injection reaches for, matched only when actually called, so the word
 *  `sleep` in a path is not a block and `sleep(` is. */
const SQL_CALLS = new Set([
    "sleep",
    "pg_sleep",
    "benchmark",
    "load_file",
    "updatexml",
    "extractvalue",
    "group_concat",
    "dbms_pipe"
]);

/** Statement heads, each meaningful only in front of its own tail: `drop table`, not
 *  a query parameter that happens to be named `drop`. */
const STATEMENT_TAILS = new Map<string, ReadonlySet<string>>([
    ["drop", new Set(["table", "database", "schema", "index", "view"])],
    ["truncate", new Set(["table"])],
    ["alter", new Set(["table", "database", "user"])],
    ["delete", new Set(["from"])],
    ["insert", new Set(["into"])]
]);

/** What may follow a `;` for it to be a second statement rather than a separator. */
const STACKED = new Set([
    "drop",
    "delete",
    "update",
    "insert",
    "select",
    "truncate",
    "alter",
    "create",
    "exec",
    "execute",
    "shutdown"
]);

/** Words that introduce the `1=1` half of a boolean injection. */
const COMPARISON_HEADS = new Set(["or", "and", "xor"]);

/** Elements that can run script, load a remote document, or steal a form post.
 *  Deliberately not every HTML tag: `<b>` in a search term is somebody quoting HTML,
 *  not somebody attacking. */
const HTML_TAGS = new Set([
    "script",
    "iframe",
    "svg",
    "img",
    "object",
    "embed",
    "applet",
    "form",
    "input",
    "textarea",
    "style",
    "base",
    "link",
    "meta",
    "body",
    "html",
    "video",
    "audio",
    "source",
    "details",
    "marquee",
    "math",
    "frame",
    "frameset",
    "template",
    "portal"
]);

/** Inline handlers, matched by name rather than by an `on*=` pattern: a parameter
 *  called `online=` is not an attack and a pattern cannot tell the two apart. */
const EVENT_HANDLERS = new Set([
    "onerror",
    "onload",
    "onclick",
    "ondblclick",
    "onmouseover",
    "onmouseenter",
    "onmouseleave",
    "onmousemove",
    "onfocus",
    "onblur",
    "onchange",
    "oninput",
    "onsubmit",
    "onreset",
    "onselect",
    "onscroll",
    "onwheel",
    "onkeydown",
    "onkeyup",
    "onkeypress",
    "onanimationstart",
    "onanimationend",
    "ontransitionend",
    "ontoggle",
    "onpageshow",
    "onpopstate",
    "onhashchange",
    "onmessage",
    "onbegin",
    "onstart",
    "onplay",
    "onended",
    "onprogress",
    "onloadstart",
    "oncanplay",
    "onauxclick",
    "oncontextmenu",
    "ondrag",
    "ondrop",
    "onpaste",
    "oncopy",
    "oncut",
    "onshow",
    "onsearch",
    "oninvalid",
    "onbeforeunload",
    "onunload"
]);

/** Script entry points, matched only when called. */
const SCRIPT_CALLS = new Set([
    "eval",
    "alert",
    "prompt",
    "atob",
    "settimeout",
    "setinterval",
    "unescape",
    "fromcharcode",
    "importscripts"
]);

/** Objects an XSS payload reads or writes, and the members it reaches for. Both
 *  halves are required: `document` alone is an English word. */
const SCRIPT_OBJECTS = new Set(["document", "window", "self", "top", "parent"]);
const SCRIPT_MEMBERS = new Set([
    "cookie",
    "write",
    "writeln",
    "location",
    "domain",
    "innerhtml",
    "outerhtml",
    "localstorage",
    "sessionstorage"
]);

/** Schemes that execute rather than fetch. */
const SCRIPT_SCHEMES = new Set(["javascript", "vbscript"]);

/**
 * Whether the value could hold a payload at all.
 *
 * The gate the fast path rests on: one bounded scan of the raw value, no allocation,
 * and a `false` here ends the check. A non-ASCII byte is not suspicious on its own -
 * it cannot be part of any signature below - but it is also not a reason to stop
 * looking, so the scan simply carries on past it.
 */
function suspicious(value: string, gate: Uint8Array): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 128 && gate[code] === 1) return true;
    }
    return false;
}

/** One hex digit's value, or -1. Written out rather than parsed with `parseInt`,
 *  which reads `2g` as 2 and would decode a malformed escape into a real character. */
function hexValue(code: number): number {
    if (code >= 48 && code <= 57) return code - 48;
    if (code >= 97 && code <= 102) return code - 87;
    if (code >= 65 && code <= 70) return code - 55;
    return -1;
}

/** Percent-decode and turn `+` into a space, leaving a malformed escape exactly as it
 *  was sent - the server behind us will do the same, and inventing a character here
 *  would be inventing a payload. */
function decodeOnce(value: string): string {
    if (value.indexOf("%") < 0 && value.indexOf("+") < 0) return value;
    let out = "";
    let index = 0;
    while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code === 43) {
            out += " ";
            index += 1;
            continue;
        }
        if (code === 37) {
            const high = hexValue(value.charCodeAt(index + 1));
            const low = hexValue(value.charCodeAt(index + 2));
            if (high >= 0 && low >= 0) {
                out += String.fromCharCode(high * 16 + low);
                index += 3;
                continue;
            }
        }
        out += value[index];
        index += 1;
    }
    return out;
}

/**
 * The value as the application will end up reading it: decoded and lowercased.
 *
 * Decoded twice, because `%2527` is `%27` is `'` and a single pass leaves the payload
 * one step short of readable. Twice is where it stops: nothing legitimate is
 * triple-encoded, and each extra pass is a pass every suspicious request pays for.
 */
function normalize(value: string): string {
    let text = decodeOnce(value);
    if (text.indexOf("%") >= 0) text = decodeOnce(text);
    return text.toLowerCase();
}

/** The end of the word starting at `start` (equal to `start` when there is none). */
function wordEnd(text: string, start: number): number {
    let index = start;
    while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code >= 128 || WORD[code] !== 1) break;
        index += 1;
    }
    return index;
}

/**
 * The first index at or after `start` that is not filler.
 *
 * Filler is whitespace and inline SQL comments, which is how a comment written between
 * `union` and `select` and four spaces written between them are the same string to
 * everything below. Quotes are NOT filler here: they are what tells `or '1'='1` apart
 * from `or a=b`.
 */
function skipFiller(text: string, start: number): number {
    let index = start;
    while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code === 32 || code === 9 || code === 10 || code === 13) {
            index += 1;
            continue;
        }
        if (code === 47 && text.charCodeAt(index + 1) === 42) {
            const close = text.indexOf("*/", index + 2);
            if (close < 0) return text.length;
            index = close + 2;
            continue;
        }
        return index;
    }
    return index;
}

/** The character code after any filler, or -1 at the end of the text. */
function codeAfterFiller(text: string, start: number): number {
    const at = skipFiller(text, start);
    return at < text.length ? text.charCodeAt(at) : -1;
}

/** The next word after any filler, or null when what follows is not one. */
function wordAfterFiller(text: string, start: number): string | null {
    const at = skipFiller(text, start);
    const end = wordEnd(text, at);
    return end > at ? text.slice(at, end) : null;
}

/**
 * Whether what follows `or` / `and` is a comparison of two constants - `1=1`,
 * `'a'='a'`, `2>1`, `1 like 1`.
 *
 * A constant is a number or a quoted string, and nothing else. That restriction is
 * the entire false-positive defence: `?filter=name or type=x` is a comparison of two
 * names and passes, while `' or 1=1--` cannot be written without one, because an
 * injected condition has to be true regardless of what the column contains.
 */
function comparesConstants(text: string, start: number): boolean {
    const left = readConstant(text, skipOpen(text, start));
    if (left < 0) return false;
    const operator = readOperator(text, skipFiller(text, left));
    if (operator < 0) return false;
    return readConstant(text, skipFiller(text, operator)) >= 0;
}

/** Past any filler and opening brackets, which an injection often wraps a condition
 *  in (`and (1=1)`). */
function skipOpen(text: string, start: number): number {
    let index = skipFiller(text, start);
    while (text.charCodeAt(index) === 40) index = skipFiller(text, index + 1);
    return index;
}

/**
 * The end of a numeric or quoted constant at `start`, or -1 when there is none.
 *
 * A quote that never closes still counts, and has to: `' or 'a'='a` is written with
 * its last quote left open precisely because the application supplies the closing one.
 * Either way the constant is bounded - a quote followed by half a page is not one.
 */
function readConstant(text: string, start: number): number {
    const code = text.charCodeAt(start);
    if (code === 39 || code === 34 || code === 96) {
        const close = text.indexOf(String.fromCharCode(code), start + 1);
        if (close > 0) return close - start <= 32 ? close + 1 : -1;
        const open = wordEnd(text, start + 1);
        return open > start + 1 && open - start <= 32 ? open : -1;
    }
    const end = wordEnd(text, start);
    if (end === start) return -1;
    // A bare word is only a constant when it is a literal: `1`, `true`, `null`. A name
    // is what an honest filter compares, and it is what this must not match.
    const word = text.slice(start, end);
    if (/^\d+$/.test(word) || word === "true" || word === "false" || word === "null") return end;
    return -1;
}

/** The end of a comparison operator at `start`, or -1 when there is none. */
function readOperator(text: string, start: number): number {
    const code = text.charCodeAt(start);
    const next = text.charCodeAt(start + 1);
    // `<>`, `!=`, `<=`, `>=` first, so the two-character forms are not read as one.
    if ((code === 60 || code === 33 || code === 62) && (next === 62 || next === 61)) return start + 2;
    if (code === 61 || code === 60 || code === 62) return start + 1;
    if (text.startsWith("like", start)) return start + 4;
    return -1;
}

/** The script-capable tag opening at `start` (`<img`, `</script`), or null. */
function tagAt(text: string, start: number): string | null {
    let index = start + 1;
    if (text.charCodeAt(index) === 47) index += 1;
    const end = wordEnd(text, index);
    if (end === index) return null;
    const tag = text.slice(index, end);
    return HTML_TAGS.has(tag) ? tag : null;
}

/** Whether a `--` at `start` ends the statement, which is what makes it a comment
 *  rather than two dashes in a slug. */
function endsStatement(text: string, start: number): boolean {
    if (start >= text.length) return true;
    const code = text.charCodeAt(start);
    return code === 32 || code === 9 || code === 10 || code === 13 || code === 38;
}

/**
 * What a keyword means where it was found, or null when it means nothing.
 *
 * `union` and `select` are the two that need to remember something, so they are
 * carried in rather than looked up: both are ordinary English words and only count
 * when the other one is in the same run of text (see `scan` for what breaks a run).
 */
function keywordVerdict(
    word: string,
    text: string,
    end: number,
    sawUnion: boolean,
    sawSelect: boolean
): string | null {
    if (sawUnion && word === "select") return "sql union select";
    if (sawSelect && word === "from") return "sql select";
    if (SQL_MARKERS.has(word)) return "sql metadata access";
    if (COMPARISON_HEADS.has(word) && comparesConstants(text, end)) return "sql always-true condition";
    if (SQL_CALLS.has(word) && codeAfterFiller(text, end) === 40) return "sql function call";
    const tail = STATEMENT_TAILS.get(word);
    if (tail) {
        const next = wordAfterFiller(text, end);
        if (next && tail.has(next)) return `sql ${word} statement`;
    }
    if (SCRIPT_CALLS.has(word) && codeAfterFiller(text, end) === 40) return "script call";
    if (EVENT_HANDLERS.has(word) && codeAfterFiller(text, end) === 61) return "html event handler";
    if (SCRIPT_SCHEMES.has(word) && text.charCodeAt(end) === 58) return "script url";
    if (word === "data" && text.startsWith(":text/html", end)) return "script url";
    if (SCRIPT_OBJECTS.has(word) && text.charCodeAt(end) === 46) {
        const member = wordAfterFiller(text, end + 1);
        if (member && SCRIPT_MEMBERS.has(member)) return "script object access";
    }
    return null;
}

/**
 * Scan one normalized value. Single pass, and the only state it carries is the three
 * facts a signature can span more than one word with.
 *
 * All three are dropped at any character that is neither a keyword nor filler -
 * `/`, `&`, `=`, `?`. That boundary is what keeps `/credit-union/select-a-plan` and
 * `?sort=select&group=from` from reading as SQL: a real injection writes its keywords
 * inside one value, separated by spaces or comments, and never across a parameter.
 */
function scan(text: string): string | null {
    let sawUnion = false;
    let sawSelect = false;
    let sawQuote = false;
    let index = 0;
    while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code < 128 && WORD[code] === 1) {
            const end = wordEnd(text, index);
            const word = text.slice(index, end);
            const verdict = keywordVerdict(word, text, end, sawUnion, sawSelect);
            if (verdict) return verdict;
            if (word === "union") sawUnion = true;
            else if (word === "select") sawSelect = true;
            index = end;
            continue;
        }
        switch (code) {
            // Quotes and brackets sit between the keywords of an injection rather than
            // breaking it up, so they carry the run instead of ending it.
            case 39:
            case 34:
            case 96:
                sawQuote = true;
                index += 1;
                continue;
            case 32:
            case 9:
            case 10:
            case 13:
            case 40:
            case 41:
            case 44:
                index += 1;
                continue;
            case 47:
                if (text.charCodeAt(index + 1) === 42) {
                    // `/*!` is MySQL's versioned comment: code that only the database
                    // runs, which is the point of writing it.
                    if (text.charCodeAt(index + 2) === 33) return "sql comment";
                    const close = text.indexOf("*/", index + 2);
                    index = close < 0 ? text.length : close + 2;
                    continue;
                }
                break;
            case 45:
                if (text.charCodeAt(index + 1) === 45 && sawQuote && endsStatement(text, index + 2)) {
                    return "sql comment";
                }
                break;
            case 59: {
                const next = wordAfterFiller(text, index + 1);
                if (next && STACKED.has(next)) return "stacked sql statement";
                break;
            }
            case 60: {
                const tag = tagAt(text, index);
                if (tag) return `html <${tag}> tag`;
                break;
            }
            default:
                break;
        }
        sawUnion = false;
        sawSelect = false;
        sawQuote = false;
        index += 1;
    }
    return null;
}

/** One part of the request, gated then scanned. */
function inspect(value: string | null | undefined, where: string, gate: Uint8Array): string | null {
    if (!value || !suspicious(value, gate)) return null;
    const verdict = scan(normalize(value));
    return verdict ? `${verdict} in the ${where}` : null;
}

/**
 * Why the request is refused, or null when nothing matched.
 *
 * A reason rather than a boolean, for the same purpose the integrity check's is: it
 * is written into the refusal, and an operator looking at a blocked request needs to
 * know which signature fired before they can trust it or turn it off.
 *
 * The query is checked first because that is where a payload almost always rides, so
 * the common attack is answered in one pass. The user agent is checked last and
 * through the stricter header gate: it is where an injection aimed at whatever logs
 * or displays the request goes instead, and it is also the one part of this that is
 * present on every single request.
 */
export function injectionFailure(request: WafInjectionRequest): string | null {
    return (
        inspect(request.query, "query", SUSPECT) ??
        inspect(request.path, "path", SUSPECT) ??
        inspect(request.userAgent, "user agent", SUSPECT_HEADER)
    );
}
