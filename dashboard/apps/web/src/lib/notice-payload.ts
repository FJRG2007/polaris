/**
 * The words and picture of a notice, as whoever draws it can take them.
 *
 * Pure, and outside `desktop-notify` (a client module) so it is asserted in a
 * test.
 *
 * A notice says who it is from as its title and where it was said - a
 * conversation, "Mail" - as a second line. Only a desktop app that says it
 * draws that line (`noticeFeatures`) is handed it apart; an older app and a
 * browser's notice have a title and a body and nothing between, so there the
 * second line joins the title rather than being lost.
 */

/** The mark a browser's notice is drawn with when it has no face of its own. */
export const NOTICE_MARK = "/polaris-mark-128.png";

export interface NoticeWords {
    readonly title: string;
    readonly subtitle?: string;
    /** The title to use where the subtitle cannot be drawn apart: the caller's
     *  own sentence for the two ("Ana in #general"). Joined with a dash when
     *  absent. */
    readonly combined?: string;
    readonly body?: string;
    /** A path on this Polaris to the sender's face. */
    readonly icon?: string;
}

export interface NoticePayload {
    readonly title: string;
    readonly subtitle?: string;
    readonly body?: string;
    readonly icon?: string;
}

/** For the desktop app, by what it says it draws. */
export function desktopNoticePayload(
    words: NoticeWords,
    features: readonly string[] | undefined
): NoticePayload {
    const subtitle = words.subtitle?.trim() ?? "";
    const drawsSubtitle = features?.includes("subtitle") ?? false;
    const drawsIcon = features?.includes("icon") ?? false;
    return {
        title: subtitle && !drawsSubtitle ? joined(words, subtitle) : words.title,
        ...(subtitle && drawsSubtitle ? { subtitle } : {}),
        ...(words.body !== undefined ? { body: words.body } : {}),
        ...(words.icon && drawsIcon ? { icon: words.icon } : {})
    };
}

/**
 * For a browser's notice: the second line in the title, and always the mark. A
 * person with no picture is answered a transparent pixel (see `api/avatar`),
 * which a browser draws as an empty tile; the desktop app measures it and falls
 * back, a browser cannot.
 */
export function browserNoticePayload(words: NoticeWords): NoticePayload & { icon: string } {
    const subtitle = words.subtitle?.trim() ?? "";
    return {
        title: subtitle ? joined(words, subtitle) : words.title,
        ...(words.body !== undefined ? { body: words.body } : {}),
        icon: NOTICE_MARK
    };
}

function joined(words: NoticeWords, subtitle: string): string {
    if (words.combined) return words.combined;
    return words.title.trim() === subtitle ? words.title : `${words.title} - ${subtitle}`;
}
