/**
 * Reading and writing what somebody has chosen their profile to look like.
 *
 * There is no permission on reading one. An appearance is drawn beside its
 * owner's name wherever their name appears, which is the entire point of it -
 * a decoration nobody but you can see is a setting with no effect - so anybody
 * who can see the person can see the style. Nothing in it is a fact about them:
 * it is five choices out of a catalogue Polaris shipped.
 *
 * Writing one is always your own, from the session, so there is no id in the
 * request to tamper with.
 *
 * A style is checked on the way out as well as on the way in. The schema is what
 * refuses a bad colour when it is saved; `readProfileStyle` is what makes a row
 * written by an older Polaris, or naming a catalogue entry since withdrawn, come
 * back as nothing rather than as something the renderer has to guess about.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

const COLUMNS = {
    banner: true,
    decoration: true,
    nameplate: true,
    effect: true,
    nameStyle: true
} as const;

/** One person's, for a page that is about them. */
export async function getProfileStyle(userId: string): Promise<core.ProfileStyle> {
    const row = await prisma.userProfileStyle.findUnique({ where: { userId }, select: COLUMNS });
    return core.readProfileStyle(row);
}

/**
 * Several people's at once, for the store the faces ask.
 *
 * Everybody asked about is in the answer, including the accounts with no row:
 * "asked and has nothing" and "not asked yet" are different states in the store,
 * and leaving the plain ones out would make it ask about them again on every
 * render for the rest of the session.
 */
export async function stylesFor(ids: readonly string[]): Promise<Map<string, core.ProfileStyle>> {
    const answer = new Map<string, core.ProfileStyle>();
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return answer;
    for (const id of wanted) answer.set(id, core.NO_PROFILE_STYLE);
    const rows = await prisma.userProfileStyle.findMany({
        where: { userId: { in: wanted } },
        select: { userId: true, ...COLUMNS }
    });
    for (const row of rows) answer.set(row.userId, core.readProfileStyle(row));
    return answer;
}

/**
 * What has changed since a browser last asked, out of the people it is drawing.
 *
 * The half that makes an appearance live without making it expensive. A screen
 * holds a few dozen faces, so this is asked about a few dozen ids and answered
 * from one indexed lookup - the cost is proportional to the people being looked
 * at, never to the number of accounts. A million accounts changing nothing costs
 * nothing, and one person changing their decoration is read by the handful of
 * browsers that happen to have their face on screen.
 *
 * `styled` is the other half of the answer, and the reason it is needed is that
 * turning everything off deletes the row (see `setProfileStyle`). A row that is
 * gone cannot be found by "changed since", so the browser says which of the
 * people it is drawing it currently believes are decorated, and anybody in that
 * list with no row has gone back to plain. It is a short list: almost nobody has
 * chosen anything.
 */
export interface StyleChanges {
    /** Only the people whose appearance is different from what the browser has. */
    readonly changed: Map<string, core.ProfileStyle>;
    /** People the browser is drawing decorated who are not decorated any more. */
    readonly cleared: string[];
}

export async function styleChangesSince(
    ids: readonly string[],
    since: Date,
    styled: readonly string[]
): Promise<StyleChanges> {
    const wanted = [...new Set(ids)];
    const changed = new Map<string, core.ProfileStyle>();
    if (wanted.length === 0) return { changed, cleared: [] };

    const rows = await prisma.userProfileStyle.findMany({
        where: { userId: { in: wanted }, updatedAt: { gt: since } },
        select: { userId: true, ...COLUMNS }
    });
    for (const row of rows) changed.set(row.userId, core.readProfileStyle(row));

    // Whose row has gone. Asked only about the ones the browser is drawing
    // decorated, so this is a lookup over a handful of ids rather than over the
    // page.
    const believed = [...new Set(styled)].filter((id) => wanted.includes(id) && !changed.has(id));
    if (believed.length === 0) return { changed, cleared: [] };
    const alive = await prisma.userProfileStyle.findMany({
        where: { userId: { in: believed } },
        select: { userId: true }
    });
    const living = new Set(alive.map((row) => row.userId));
    return { changed, cleared: believed.filter((id) => !living.has(id)) };
}

/**
 * Save your own.
 *
 * A style that says nothing takes its row away rather than storing five nulls:
 * the row exists to record a decision, and "I turned it all off" is the absence
 * of one. It also keeps the table the size of the number of people who actually
 * chose something.
 */
export async function setProfileStyle(userId: string, input: core.ProfileStyleInput): Promise<void> {
    const style: core.ProfileStyle = {
        banner: input.banner,
        decoration: input.decoration,
        nameplate: input.nameplate,
        effect: input.effect,
        nameStyle: input.nameStyle
    };
    if (core.styleIsPlain(style)) {
        await prisma.userProfileStyle.deleteMany({ where: { userId } });
        return;
    }
    const row = {
        banner: core.writeFill(style.banner),
        decoration: style.decoration,
        nameplate: style.nameplate,
        effect: style.effect,
        nameStyle: style.nameStyle
    };
    await prisma.userProfileStyle.upsert({
        where: { userId },
        create: { userId, ...row },
        update: row
    });
}
