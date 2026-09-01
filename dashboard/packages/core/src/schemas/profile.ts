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

/** One line under a name. Long enough for "Infrastructure, on the storage team",
 *  short enough that it cannot become the bio. */
export const MAX_HEADLINE = 80;

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
        .refine((value) => {
            if (!value) return false;
            try {
                const parsed = new URL(value);
                return parsed.protocol === "https:" || parsed.protocol === "http:";
            } catch {
                return false;
            }
        }, "Enter a web address")
});

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
