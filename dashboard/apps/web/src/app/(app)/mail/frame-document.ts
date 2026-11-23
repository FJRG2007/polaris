/**
 * The document a received message is drawn inside: its policy, base target,
 * colours, height reporter and link handling. Kept apart from the React
 * component so the desktop app's Electron harness can draw exactly this page
 * without the rest of the dashboard (desktop/test/electron/links).
 */

import * as selectionMenu from "@/lib/selection-menu";

/**
 * How a message is coloured.
 *
 * The hard case, and the reason this is a choice rather than a constant. A
 * newsletter carries its own colours and was designed against a white page:
 * drawing it on a dark one leaves black text on black, which is the single most
 * common complaint about dark mode in any mail client. A plain message carries
 * no colours at all, and drawing THAT on white is a bright rectangle in the
 * middle of a dark screen.
 *
 * So: a message that dresses itself keeps its own page, and one that does not
 * takes the reader's. Either way the reader can say otherwise, per message,
 * because the guess is a heuristic and heuristics are wrong sometimes.
 */
export type MessagePaper = "own" | "reader";

/**
 * Whether the message brought a page of its own.
 *
 * A background is the test, and a text colour is not. A newsletter that set a
 * background was designed against it, and taking that away is what leaves black
 * text on black. The much commoner thing - an automated message that sets a
 * colour on a heading or a signature and nothing else - was designed against
 * whatever page it happened to land on, which for most of its life was white
 * because that is what its author's client used. Treating those as designed put
 * a bright white card in the middle of a dark screen for every receipt and
 * password reset anybody gets, and there was nothing in them that needed it.
 *
 * They take the reader's page instead, with their own colours neutralised so
 * nothing arrives unreadable - see `frameDocument`. What is lost is a coloured
 * heading; what is gained is a mailbox that looks like one screen.
 */
export function dressesItself(html: string): boolean {
    return /(?:\bbackground(?:-color)?\s*:|\bbgcolor\s*=)/i.test(html);
}

/**
 * The reader's own colours, read off the page this frame is drawn in.
 *
 * Taken from the live tokens rather than restated, so the frame follows whatever
 * theme is in force - including a light one, a dark one, and one an operator has
 * changed the values of. `dark` is decided from the lightness of the background
 * token rather than from a media query, for the same reason: what matters is the
 * page this is actually sitting on, not what the device prefers.
 */
function readerColors(): { foreground: string; link: string; dark: boolean } {
    if (typeof window === "undefined")
        return { foreground: "inherit", link: "#4f7cff", dark: false };
    const style = getComputedStyle(document.documentElement);
    const raw = (name: string) => style.getPropertyValue(name).trim();
    const token = (name: string, fallback: string) => {
        const held = raw(name);
        return held ? `hsl(${held})` : fallback;
    };
    // The tokens are written as "H S% L%", so the last number is the lightness.
    const lightness = Number(/(\d+(?:\.\d+)?)%\s*$/.exec(raw("--background"))?.[1] ?? "100");
    return {
        foreground: token("--foreground", "#111"),
        link: token("--primary", "#4f7cff"),
        dark: Number.isFinite(lightness) && lightness < 50
    };
}

/** The wrapper the message is drawn inside. Nothing here is the message's: the
 *  policy, the base target, the colours and the height reporter are all ours. */
export function frameDocument(
    body: string,
    showRemote: boolean,
    paper: MessagePaper,
    origin: string
): string {
    // Only this origin, and only when the mailbox draws pictures at all. Not
    // `https:` - that would let a message fetch straight from its sender and
    // undo the whole point of serving them through here.
    const images = showRemote ? `img-src ${origin} data: cid:;` : "img-src data:;";
    const colors = readerColors();
    // `color-scheme` is what stops a browser inverting form controls and
    // scrollbars inside the frame against the page it is actually drawn on.
    const page =
        paper === "own"
            ? "color-scheme:light;background:#ffffff;color:#111111;"
            : `color-scheme:${colors.dark ? "dark" : "light"};background:transparent;color:${colors.foreground};`;
    const linkColor = paper === "own" ? "#1a56db" : colors.link;
    // A page of its own is a sheet of paper, and text has never been printed
    // flush to the edge of one. A designed newsletter brings its own outer
    // table and does not need this; the plain white rectangle a simple message
    // gets is exactly what looked wrong without it.
    const inset = paper === "own" ? "padding:16px;" : "";
    // Their colours, on our page, made readable.
    //
    // Only ever on the reader's page, and only ever colours: a message that got
    // here set no background of its own, so its author had no idea what would be
    // behind their dark grey heading - and on a dark page it is not there at all.
    // Anything the message drew rather than wrote is untouched, which is why this
    // leaves images, borders and layout exactly as they are.
    const adapt =
        paper === "reader"
            ? `#polaris-body,#polaris-body *:not(a){color:inherit!important;background-color:transparent!important;}
  #polaris-body a{color:${linkColor}!important;}`
            : "";
    return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${images} style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none';">
<base target="_blank">
<style>
  html{${page}}
  html,body{margin:0;padding:0;}
  body{${inset}}
  body{font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;word-break:break-word;overflow-wrap:anywhere;}
  img,video,table{max-width:100%;height:auto;}
  table{border-collapse:collapse;}
  blockquote{margin:0 0 0 .75rem;padding-left:.75rem;border-left:2px solid rgba(127,127,127,.4);}
  /* What a plain-text message is wrapped in: its own line breaks are the
     layout, and a long address must wrap rather than widen the frame. */
  .plain{white-space:pre-wrap;word-break:break-word;}
  .quoted{opacity:.65;}
  a{color:${linkColor};}
  ${adapt}
</style>
<script>
  // The one thing the frame is allowed to do: say how tall it is, so the page
  // can size it. It cannot reach the page - the sandbox withheld same-origin -
  // and the page treats what arrives as a number and nothing else.
  //
  // In the head, before the message: whatever the message's markup does to the
  // rest of the document, it cannot swallow this or stop it running.
  (function () {
    function measure() {
      var root = document.getElementById("polaris-body");
      var html = document.documentElement;
      return Math.max(
        root ? root.scrollHeight : 0,
        root ? Math.ceil(root.getBoundingClientRect().height) : 0,
        document.body ? document.body.scrollHeight : 0,
        // The page's own box, not its scroll height: the html height is forced
        // back to auto at the end of the document, so this is the content plus
        // the padding a page of its own is drawn with - while a scroll height
        // is never less than the frame and would stop a short message shrinking.
        html ? Math.ceil(html.getBoundingClientRect().height) : 0
      );
    }
    function tell() { parent.postMessage({ polarisMailHeight: measure() }, "*"); }
    function watch() {
      var root = document.getElementById("polaris-body");
      if (root && typeof ResizeObserver === "function") new ResizeObserver(tell).observe(root);
      tell();
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
    else watch();
    window.addEventListener("load", tell);
    // A picture that arrives after the layout settled changes the height, and a
    // message is mostly pictures.
    window.addEventListener("resize", tell);
    setTimeout(tell, 300);
    setTimeout(tell, 1500);
    // The other thing it says: a right-click on selected text, so Polaris's own
    // selection menu opens over the message as it does everywhere else. Only
    // the selected text and the point travel.
    window.addEventListener("contextmenu", function (event) {
      var selection = window.getSelection();
      var text = selection ? String(selection) : "";
      var x = event.clientX, y = event.clientY;
      // Never the browser's own menu over a message: Polaris's, or nothing.
      event.preventDefault();
      if (!text.trim()) {
        // A link or a picture with nothing selected: Polaris's menu for it, as
        // on any page. Only the addresses travel, and the page checks them too.
        var link = linkAt(event.target);
        var href = link && link.href ? link.href : "";
        var picture = event.target && event.target.closest ? event.target.closest("img") : null;
        var image = picture ? (picture.currentSrc || picture.src || "") : "";
        if (!/^https?:/i.test(image)) image = "";
        if (!href && !image) return;
        var said = { x: x, y: y };
        if (href) said.href = href;
        if (image) said.image = image;
        parent.postMessage({ polarisMailMenu: said }, "*");
        return;
      }
      if (text.length > ${selectionMenu.FRAMED_SELECTION_MAX}) return;
      if (event.button !== 2 || (x === 0 && y === 0)) {
        var rect = selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
        if (rect) { x = rect.left; y = rect.bottom; }
      }
      event.preventDefault();
      parent.postMessage({ polarisMailMenu: { x: x, y: y, text: text } }, "*");
    }, true);
    // A click on a link is handed to the page, which opens it the way every
    // other link in Polaris opens. Left to the frame, it is a popup out of a
    // sandbox, and the phone app's WebView has nowhere to put one: the click
    // did nothing. A link to a place in the message scrolls there instead.
    //
    // What the link points at is decided before the click is touched: a click
    // is only ever cancelled when it is opened from here, scrolled, or refused
    // for its scheme - never for a link this script could not read. SVG links
    // (whose href is not a string) and image-map areas are read here, so none
    // of them is swallowed silently. A relative address was already resolved
    // against the message's own <base> by the sanitizer; one still relative
    // here has no base at all - this frame's is the Polaris page, and resolving
    // against it would open a Polaris address the sender never wrote - so it
    // is refused. A scheme-relative one ("//host/x") is taken as https.
    function linkAt(node) {
      var found = node && node.closest ? node.closest("a, area") : null;
      if (!found) return null;
      var raw = found.getAttribute("href");
      if (raw === null) raw = found.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      if (raw === null) return null;
      raw = String(raw).trim();
      if (raw.charAt(0) === "#") return { fragment: raw.slice(1) };
      var url;
      try { url = new URL(raw.slice(0, 2) === "//" ? "https:" + raw : raw); } catch (error) { return { refused: true }; }
      if (!/^(https?:|mailto:)$/i.test(url.protocol)) return { refused: true };
      return { href: url.href };
    }
    function follow(event) {
      if (event.button !== 0 && event.button !== 1) return;
      var link = linkAt(event.target);
      if (!link) return;
      event.preventDefault();
      if (link.fragment !== undefined) {
        var name = link.fragment;
        var spot = name && (document.getElementById(name) || document.getElementsByName(name)[0]);
        if (spot && spot.scrollIntoView) spot.scrollIntoView();
        return;
      }
      if (link.href) parent.postMessage({ polarisMailOpen: link.href }, "*");
    }
    document.addEventListener("click", follow, true);
    document.addEventListener("auxclick", follow, true);
  })();
</script>
</head><body><div id="polaris-body">${body}</div>
<style>
  /* Last in the cascade on purpose, so it beats the message's own sheet.
     Newsletters set html,body height 100% all the time, which makes the
     document exactly as tall as the frame however long the message is - so the
     frame stayed at its opening height and scrolled inside itself, next to the
     pane already scrolling outside it. */
  html,body{height:auto!important;min-height:0!important;overflow:visible!important;}
  /* A message that turned selection off (user-select:none on everything is a
     common newsletter template) left nothing in it to select or copy. */
  #polaris-body,#polaris-body *{-webkit-user-select:text!important;user-select:text!important;}
</style>
</body></html>`;
}
