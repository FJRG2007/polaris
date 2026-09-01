/**
 * The things a person writes about themselves that are not their name.
 *
 * A headline, a bio, how they want to be referred to, and the addresses they
 * want handed out with them. Four separate answers rather than one "about"
 * field, because they are read in four different places: the headline sits under
 * a name in a list, the bio is a paragraph nobody reads in a list, the pronouns
 * belong beside the name itself, and a link is a thing to press.
 *
 * Pure, so the form refuses exactly what the server refuses.
 */

import { z } from "zod";

/** One line under a name. Long enough for what people actually write there -
 *  a role, a team and what they are working on - and still short enough that it
 *  cannot become the bio, which is the paragraph underneath. */
export const MAX_HEADLINE = 220;

export const headlineField = z
    .string()
    .trim()
    .max(MAX_HEADLINE, `At most ${MAX_HEADLINE} characters`)
    // Collapsed rather than rejected: a headline pasted out of a document
    // arrives with a line break in it, and refusing that is refusing the paste
    // rather than the content.
    .transform((value) => value.replace(/\s+/g, " "));

/**
 * How somebody wants to be referred to.
 *
 * Offered as a short list of the answers people actually give, plus their own
 * words - a chooser with no way out is a chooser that is wrong for somebody. An
 * empty value is not "unset waiting to be filled in": it is a person who has not
 * said, and nothing is drawn for them.
 */
export const PRONOUN_CHOICES = ["they/them", "she/her", "he/him", "she/they", "he/they"] as const;

/** Short, because it is drawn beside a name. Anything longer is a sentence, and
 *  the bio is where a sentence goes. */
export const MAX_PRONOUNS = 24;

export const pronounsField = z
    .string()
    .trim()
    .max(MAX_PRONOUNS, `At most ${MAX_PRONOUNS} characters`)
    .transform((value) => value.replace(/\s+/g, " "));

/** How many addresses one profile carries. Past this it is a link farm. */
export const MOST_PROFILE_LINKS = 6;

export const MAX_LINK_LABEL = 40;

/**
 * One address on a profile.
 *
 * `https` is added when somebody typed a bare host, because they typed a website
 * and not a URL - and only `http(s)` is accepted, because a profile is a page
 * other people press things on and `javascript:` is the reason that matters.
 * The label is optional: an address with no name is drawn as its own host, which
 * is what GitHub does and what people expect.
 */
export const profileLinkSchema = z.object({
    label: z.string().trim().max(MAX_LINK_LABEL, `At most ${MAX_LINK_LABEL} characters`).default(""),
    url: z
        .string()
        .trim()
        .max(2048)
        .transform((value) => (value && !/^[a-z][a-z0-9+.-]*:/i.test(value) ? `https://${value}` : value))
        .refine((value) => linkProblem(value) === null, "Enter a web address")
});

/**
 * What is wrong with a typed address, in the words the field says it in, or null
 * when there is nothing wrong with it.
 *
 * Split out from the schema so the form can say WHICH of the three it is while
 * somebody types - "https" on its own, a scheme that is not the web, or a host
 * with no dot in it are three different mistakes and one message for all of them
 * is a message nobody can act on. The schema refuses exactly what this refuses.
 */
export function linkProblem(value: string): string | null {
    const typed = value.trim();
    if (!typed) return "Enter a web address";
    // A bare host is what people type, so it is completed rather than refused -
    // the same thing the schema does before it checks.
    const full = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;

    let parsed: URL;
    try {
        parsed = new URL(full);
    } catch {
        return "That is not a web address";
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return "Only http:// and https:// addresses";
    }
    // `https` on its own parses as a host called "https" with nothing after it.
    // Refused for the reason any single word is: there is no such site, and a
    // profile that printed it would print a dead link.
    if (!parsed.hostname.includes(".") || parsed.hostname.endsWith(".")) {
        return "That address has no site in it";
    }
    return null;
}

export type ProfileLink = z.infer<typeof profileLinkSchema>;

export const profileLinksSchema = z.array(profileLinkSchema).max(MOST_PROFILE_LINKS);

/** What a link is called when its owner did not name it: its host, without the
 *  `www.` nobody reads. */
export function linkLabel(link: ProfileLink): string {
    if (link.label) return link.label;
    try {
        return new URL(link.url).hostname.replace(/^www\./, "");
    } catch {
        return link.url;
    }
}
