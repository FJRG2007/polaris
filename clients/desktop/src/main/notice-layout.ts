/**
 * How a notice's words are laid out on each system's notice.
 *
 * Pure, so it is asserted in a test without an Electron runtime.
 *
 * Who it is from is the title, and where it was said - a conversation, "Mail" -
 * is the line under it. Only macOS draws that second line (`subtitle`); Windows
 * and Linux have a title and a body and nothing between them, so there it joins
 * the title, the way Element and Signal desktop name the room beside the sender.
 */

/** The longest title the system is handed: Windows cuts a toast's title at about
 *  one line anyway, and a longer one only pushes the body off the notice. */
const TITLE_MAX = 120;

export interface NoticeWords {
    readonly title: string;
    readonly subtitle?: string;
    readonly body?: string;
}

export interface NoticeLayout {
    readonly title: string;
    readonly subtitle?: string;
    readonly body: string;
}

function clip(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

export function noticeLayout(words: NoticeWords, platform: NodeJS.Platform): NoticeLayout {
    const title = words.title.trim();
    const subtitle = words.subtitle?.trim() ?? "";
    const body = words.body ?? "";
    if (!subtitle || subtitle === title) return { title: clip(title, TITLE_MAX), body };
    if (platform === "darwin") return { title: clip(title, TITLE_MAX), subtitle: clip(subtitle, TITLE_MAX), body };
    return { title: clip(`${title} - ${subtitle}`, TITLE_MAX), body };
}

/** The picture types a notice's icon may be: what `nativeImage` decodes. */
export const ICON_TYPES: readonly string[] = ["image/png", "image/jpeg"];

/** The picture types a notice asks the Polaris for: a stored WebP or GIF face
 *  is then answered as a PNG instead of a picture this cannot draw. */
export const ICON_ACCEPT = ICON_TYPES.join(", ");

/** The largest avatar Polaris stores (`MAX_AVATAR_BYTES`); anything bigger is
 *  not an avatar. */
export const ICON_MAX_BYTES = 2 * 1024 * 1024;

/** Whether a fetched picture may be a notice's icon. */
export function iconAcceptable(contentType: string | null, size: number): boolean {
    const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    return ICON_TYPES.includes(type) && size > 0 && size <= ICON_MAX_BYTES;
}
