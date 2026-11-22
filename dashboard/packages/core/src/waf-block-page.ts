/**
 * The page a blocked visitor gets, in place of a bare "Forbidden".
 *
 * A block is the one firewall outcome an ordinary person sees, and most of the people
 * who see it are not attackers: a visitor on a shared address, a request that tripped a
 * signature, an operator testing their own rule. A blank 403 tells all of them nothing
 * and leaves the site owner with nothing to be asked about, so a block answers with a
 * page that says what happened and carries a reference to quote.
 *
 * It lives here because a block is decided in two places that share nothing else: the
 * edge guard, which refuses a request on the app's own domain, and Polaris, which
 * refuses to mint an edge login for an account the rule does not admit. Two pages would
 * drift, and the second one is reached by the same visitor as the first.
 *
 * What the guard's page deliberately does not say is WHICH rule matched. The reason
 * travels with the decision, for the operator; on the page it would let anyone map the
 * ruleset by probing it until the wording changed. `cause` is what the page CAN say:
 * a property of the visitor's connection (Tor, a VPN, a datacenter, a rate limit), a
 * signed-in account refused by name, or the operator's own message on a rule - see
 * `waf-block-cause.ts` for where that line is drawn and why.
 *
 * The reference is the caller's to generate, and today nothing generates one that
 * outlives the response: it gives a visitor something to quote and the page the shape it
 * keeps once blocks are recorded, at which point this becomes the recorded id.
 */

import { edgePage, edgeText } from "./edge-page.js";
import type { Locale, TextDirection } from "./i18n/locales.js";
import {
    fillBlockCopy,
    wafBlockAdvice,
    wafBlockChangeable,
    wafBlockCopy,
    wafBlockSentence,
    wafBlockStatesUntil,
    type WafBlockCause
} from "./waf-block-cause.js";

/** What the page says about the request it refused. */
export interface WafBlockPageInput {
    /** An id for the visitor to quote back. */
    readonly reference: string;
    /** The site the request was for, so a visitor knows which one refused them. */
    readonly host?: string;
    /** The address the firewall judged (leftmost X-Forwarded-For). */
    readonly ip?: string | null;
    /** Why, as a code: decides the sentence and the advice (`waf-block-cause.ts`).
     *  Absent is the generic sentence, which describes the class of blocks only. */
    readonly cause?: WafBlockCause;
    /** The operator's words for a `custom` cause. Escaped and capped here. */
    readonly message?: string;
    /** When a timed block lifts (epoch ms), for a cause that states it. */
    readonly until?: number | null;
    /** The language to speak, from the visitor's Accept-Language; English if absent. */
    readonly locale?: Locale;
    readonly dir?: TextDirection;
    /** @deprecated Pass `cause`. Replaces the generic "why" when no cause is given. */
    readonly explanation?: string;
    /** For an automatic ban the visitor can get out of: when it lifts by itself
     *  (epoch ms, or null for never) and where to sign in to lift it now. Says how,
     *  without saying which rule. */
    readonly release?: { readonly until: number | null; readonly signIn: string | null };
    /**
     * The nonce the response's CSP allows, for the Try again button's script. A
     * desktop app or an installed page has no reload button, and a person who was
     * let back in has to be able to find out without restarting anything. Without
     * it the page is inert and has no button.
     */
    readonly retryNonce?: string;
}

/**
 * How long Try again waits after each go: 5 seconds, doubling, never more than a
 * minute, starting over after ten quiet minutes. Kept in the tab, so a reload
 * that lands on this page again picks up the wait instead of resetting it.
 */
const RETRY_SCRIPT = `(function () {
  var button = document.getElementById("edge-retry");
  if (!button) return;
  var key = "polaris.edge.retry";
  var label = button.textContent;
  function read() {
    try { return JSON.parse(sessionStorage.getItem(key) || "{}") || {}; } catch (e) { return {}; }
  }
  function write(value) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  var state = read();
  if (!state.at || Date.now() - state.at > 600000) state = {};
  function tick() {
    var left = Math.ceil(((state.next || 0) - Date.now()) / 1000);
    if (left > 0) {
      button.disabled = true;
      button.textContent = label + " (" + left + "s)";
      setTimeout(tick, 500);
    } else {
      button.disabled = false;
      button.textContent = label;
    }
  }
  button.addEventListener("click", function () {
    if (button.disabled) return;
    var count = (state.count || 0) + 1;
    var wait = Math.min(60, 5 * Math.pow(2, count - 1));
    state = { count: count, at: Date.now(), next: Date.now() + wait * 1000 };
    write(state);
    location.reload();
  });
  var when = document.getElementById("edge-until");
  if (when) {
    var at = new Date(when.getAttribute("datetime") || "");
    if (!isNaN(at.getTime())) when.textContent = at.toLocaleString();
  }
  tick();
})();`;

/** A time as the page shows it: an ISO stamp the page's script rewrites into the
 *  reader's own clock, readable as UTC until it does. */
function timeElement(until: number): string {
    const iso = new Date(until).toISOString();
    return `<time id="edge-until" datetime="${iso}">${iso.replace("T", " ").slice(0, 16)} UTC</time>`;
}

/** The "what can I do" paragraph: the advice for the cause, when a timed block lifts,
 *  and that signing in lifts it, in that order. */
function adviceText(input: WafBlockPageInput, cause: WafBlockCause, locale: Locale | undefined): string {
    const copy = wafBlockCopy(locale);
    const until = input.until ?? input.release?.until ?? null;
    const parts: string[] = [];
    if (wafBlockStatesUntil(cause) && until !== null && Number.isFinite(until)) {
        const template = cause === "rate_limited" ? copy.tryAt : copy.liftsAt;
        parts.push(fillBlockCopy(template, { at: timeElement(until) }));
    }
    if (input.release?.signIn) parts.push(copy.signInLifts);
    parts.push(parts.length > 0 && !wafBlockChangeable(cause) ? copy.otherwise : wafBlockAdvice(cause, locale));
    return parts.join(" ");
}

/** A shield, drawn as the contents of a stroked 24x24 viewBox. */
const SHIELD =
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>';

/**
 * The cause a page states. An explicit `cause` wins; `explanation` is the older way
 * of saying the same thing and is kept for callers that still pass it; a ban with a
 * release and nothing else is the automatic, timed one it always meant.
 */
function causeOf(input: WafBlockPageInput): WafBlockCause {
    if (input.cause) return input.cause;
    if (input.release) return "temporary_ban";
    return "firewall";
}

/** Render the block page for one refused request. */
export function wafBlockPage(input: WafBlockPageInput): string {
    const locale = input.locale;
    const copy = wafBlockCopy(locale);
    const cause = causeOf(input);
    const why =
        !input.cause && input.explanation
            ? edgeText(input.explanation, copy.causes.firewall, 400)
            : edgeText(wafBlockSentence({ cause, message: input.message }, locale), copy.causes.firewall, 400);
    return edgePage({
        lang: locale ?? "en-US",
        dir: input.dir ?? "ltr",
        title: copy.title,
        badge: copy.title,
        tone: "danger",
        icon: SHIELD,
        heading: copy.heading,
        lead: fillBlockCopy(copy.lead, { host: edgeText(input.host, copy.thisSite) }),
        sections: [
            { heading: copy.why, body: why },
            { heading: copy.whatToDo, body: adviceText(input, cause, locale) }
        ],
        actions: [
            ...(input.release?.signIn
                ? [{ label: copy.signIn, href: edgeText(input.release.signIn, "", 400), primary: true }]
                : []),
            ...(input.retryNonce ? [{ label: copy.tryAgain, id: "edge-retry" }] : [])
        ],
        facts: [
            { label: copy.reference, value: edgeText(input.reference, copy.unavailable, 64) },
            { label: copy.yourIp, value: edgeText(input.ip, "") }
        ],
        note: copy.protectedBy,
        ...(input.retryNonce ? { script: { nonce: input.retryNonce, source: RETRY_SCRIPT } } : {})
    });
}
