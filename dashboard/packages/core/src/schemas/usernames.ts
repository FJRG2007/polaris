/**
 * The usernames nobody may take.
 *
 * A username is a public identity here: it addresses a profile, it is what
 * somebody hands out to be added, and it is printed beside everything they
 * write. Which makes a handful of them dangerous rather than merely confusing -
 * "polaris", "support", "billing" and "security" are the names every account
 * takeover and every refund scam is signed with, and an account holding one of
 * them is handed the deployment's own voice for free.
 *
 * Three groups, and each is here for its own reason:
 *
 *   - **This product.** `polaris` and anything starting with it. A message from
 *     `@polaris-security` is indistinguishable from the system speaking.
 *   - **Roles nobody holds.** support, admin, billing, moderator, staff. These
 *     are what somebody impersonates rather than what somebody is called.
 *   - **Words a URL might mean.** The profile lives under a prefix precisely so
 *     a person can be called anything, so this is not about route collisions -
 *     but `api`, `www`, `login` and `settings` in an address still read as the
 *     product speaking rather than as a person.
 *
 * Enforced when a name is chosen or changed, not retroactively: an account that
 * already holds one predates this, and taking somebody's name away on the day
 * they next open their settings is worse than the risk of leaving it.
 *
 * Pure, so the field refuses as it is typed and the server refuses the same
 * input for the same reason.
 */

/** Anything at or under this is the product speaking, never a person. */
const PRODUCT_PREFIX = "polaris";

const RESERVED = new Set([
    // The product, and the roles it would be mistaken for.
    "polaris",
    "admin",
    "administrator",
    "root",
    "superuser",
    "sysadmin",
    "system",
    "staff",
    "team",
    "official",
    "moderator",
    "mod",
    "support",
    "helpdesk",
    "help",
    "security",
    "abuse",
    "billing",
    "payments",
    "payment",
    "invoice",
    "refund",
    "verify",
    "verification",
    "noreply",
    "no-reply",
    "postmaster",
    "webmaster",
    "hostmaster",
    // Words that read as the product rather than as somebody.
    "api",
    "www",
    "mail",
    "smtp",
    "ftp",
    "cdn",
    "static",
    "assets",
    "status",
    "health",
    "info",
    "contact",
    "about",
    "legal",
    "privacy",
    "terms",
    "docs",
    "blog",
    "news",
    "account",
    "accounts",
    "settings",
    "profile",
    "profiles",
    "user",
    "users",
    "me",
    "you",
    "everyone",
    "here",
    "all",
    "login",
    "signin",
    "sign-in",
    "logout",
    "signout",
    "signup",
    "sign-up",
    "register",
    "auth",
    "oauth",
    "sso",
    "token",
    "invite",
    "null",
    "undefined",
    "true",
    "false"
]);

/** Whether a name is one nobody may take. Case and spacing are already the
 *  field's business; this answers about the normalized form. */
export function isReservedUsername(value: string): boolean {
    const name = value.trim().toLowerCase();
    if (!name) return false;
    if (name === PRODUCT_PREFIX || name.startsWith(`${PRODUCT_PREFIX}-`) || name.startsWith(`${PRODUCT_PREFIX}_`)) {
        return true;
    }
    return RESERVED.has(name);
}

/** Said the same way wherever it is refused. Deliberately does not list the
 *  reserved names: a message that did would be a list to work through. */
export const RESERVED_USERNAME_MESSAGE = "That name is kept for Polaris itself";
