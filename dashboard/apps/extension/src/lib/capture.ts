/**
 * What to do with a login somebody has just typed into a page.
 *
 * The decision, not the offering: this says whether what was submitted is worth
 * saving, worth replacing a saved password with, or already exactly what the
 * vault holds - and nothing else in the extension gets to decide it. Pure, so
 * the cases that matter can be asserted without a browser, a vault or a form.
 *
 * The one that has to be right is the third. A manager that offers to save every
 * sign-in teaches people to dismiss it, and the dismissal becomes the reflex that
 * also throws away the one offer that mattered - the password they have just
 * changed. So a submission that matches what is already stored produces nothing
 * at all.
 *
 * Ambiguity produces nothing too. Two saved logins with the same username on the
 * same site is not unusual here - a personal vault and an organization's often
 * hold the same account - and there is no way from a form to tell which of them
 * was just used. Replacing the wrong one silently is worse than saying nothing,
 * and the popup is where somebody can see both and choose.
 */

/** Enough of a saved login to compare a submission against. */
export interface SavedLogin {
    readonly id: string;
    readonly name: string;
    readonly username: string | null;
    readonly password: string | null;
}

/** What a page's form was carrying when it was submitted. */
export interface Submitted {
    readonly username: string;
    readonly password: string;
}

/** What, if anything, to offer for it. */
export type CaptureOffer =
    | { readonly kind: "none" }
    | { readonly kind: "save"; readonly username: string | null; readonly password: string }
    | {
          readonly kind: "update";
          readonly id: string;
          /** The item's name, so the bar can say which login is about to change. */
          readonly name: string;
          readonly username: string | null;
          readonly password: string;
      };

/** Nothing to offer, as the value rather than the shape. */
const NOTHING: CaptureOffer = { kind: "none" };

/**
 * Decide what a submission is worth, against what this site already has saved.
 *
 * `saved` is the items that match the page, closest first - the same order and
 * the same rule the list in the popup is built from.
 *
 * A submission with no username is a change-password form, which is the one shape
 * that genuinely has nothing to name itself with. It is matched against the page
 * rather than against a name, and only when the page has exactly one saved login
 * is there an answer that cannot be the wrong one.
 */
export function offerFor(submitted: Submitted, saved: readonly SavedLogin[]): CaptureOffer {
    const password = submitted.password;
    if (password === "") return NOTHING;

    const username = submitted.username.trim();
    const candidates =
        username === ""
            ? [...saved]
            : saved.filter((item) => same(item.username, username));

    // Already exactly what is stored. Nothing has changed, so there is nothing to
    // say - and this is the case that keeps the bar rare enough to be read.
    if (candidates.some((item) => item.password === password)) return NOTHING;

    if (candidates.length === 0) {
        // A password typed on a site with nothing saved for it, or under a
        // username the vault has never seen: a new item either way.
        return { kind: "save", username: username === "" ? null : username, password };
    }

    const only = candidates.length === 1 ? candidates[0] : null;
    if (!only) return NOTHING;
    return {
        kind: "update",
        id: only.id,
        name: only.name,
        username: username === "" ? only.username : username,
        password
    };
}

/** Whether two usernames are the same one. Case and surrounding space are how
 *  the same address is typed twice, not two different accounts. */
function same(saved: string | null, typed: string): boolean {
    return (saved ?? "").trim().toLowerCase() === typed.toLowerCase();
}
