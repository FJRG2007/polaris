/**
 * Hardware (MAC) addresses: reading one somebody typed, and the box it is typed into.
 *
 * A device on a home network is lent its IP address by the router, and the
 * lease can change on any reboot. What does not change is its hardware address,
 * and it is often the only one its maker's app shows - a Gree air conditioner's
 * app lists the MAC, usually as twelve bare digits, and no IP at all. So anywhere
 * Polaris asks where a device is, a MAC is an answer too, and Polaris works out
 * the IP from it.
 *
 * Two ways of reading one, for two kinds of source:
 *
 * - `parseMac` is for what a person typed. It accepts the spellings people
 *   actually copy - `aabbccddeeff`, `AA:BB:CC:DD:EE:FF`, `AA-BB-CC-DD-EE-FF`,
 *   and Cisco's `aabb.ccdd.eeff` - and nothing else, so a typo is a typo rather
 *   than a different address.
 * - `macHex` is for what a machine reported (a neighbour table, a protocol
 *   answer): whatever the separators, twelve hex digits or nothing.
 *
 * The rest is the field: `formatMacInput`, `macBackspace` and `macDelete` keep a
 * single input formatted as `AA:BB:CC:DD:EE:FF` while it is typed into, with the
 * caret where the person expects it. Pure, so the caret rules are tested
 * without a browser.
 */

/** Twelve hex digits, lowercase, or null. The all-zero address is what an
 *  unresolved neighbour entry shows and the all-ones one is broadcast: neither
 *  is a device. */
export function macHex(value: string | null | undefined): string | null {
    if (!value) return null;
    const hex = value.toLowerCase().replace(/[^0-9a-f]/g, "");
    if (hex.length !== 12 || /^0+$/.test(hex) || /^f+$/.test(hex)) return null;
    return hex;
}

/** Twelve hex digits as `AA:BB:CC:DD:EE:FF`. */
function canonical(hex: string): string {
    return hex.toUpperCase().match(/../g)!.join(":");
}

/** The spellings a person copies a MAC in. */
const SPELLINGS = [
    /^[0-9a-f]{12}$/i,
    /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i,
    /^[0-9a-f]{2}(-[0-9a-f]{2}){5}$/i,
    /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i
];

/**
 * A typed MAC as `AA:BB:CC:DD:EE:FF`, or null when it is not one a device could
 * have: an unknown spelling, the all-zero or broadcast address, or a group
 * (multicast) address, which no device answers as.
 */
export function parseMac(value: string | null | undefined): string | null {
    const trimmed = (value ?? "").trim();
    if (!SPELLINGS.some((spelling) => spelling.test(trimmed))) return null;
    const hex = macHex(trimmed);
    if (!hex) return null;
    if ((Number.parseInt(hex.slice(0, 2), 16) & 1) === 1) return null;
    return canonical(hex);
}

export function isMac(value: string | null | undefined): boolean {
    return parseMac(value) !== null;
}

/** The two hardware addresses are the same device's, however each is spelled. */
export function sameMac(a: string | null | undefined, b: string | null | undefined): boolean {
    const left = macHex(a);
    return left !== null && left === macHex(b);
}

/** The first MAC written anywhere in a piece of text, for a paste that brings
 *  more than the address with it ("MAC: aa:bb:cc:dd:ee:ff"). */
export function macInText(text: string): string | null {
    const tokens = text.match(/[0-9a-f:.-]{12,17}/gi) ?? [];
    for (const token of tokens) {
        const found = parseMac(token);
        if (found) return found;
    }
    return null;
}

/** What is wrong with a value typed into a MAC box, or null when it is a whole
 *  address. Empty is not wrong, only unfinished: the caller treats it as such. */
export function macIssue(value: string): "short" | "reserved" | null {
    const hex = value.replace(/[^0-9a-f]/gi, "");
    if (hex.length < 12) return "short";
    return parseMac(canonical(hex.slice(0, 12).toLowerCase())) ? null : "reserved";
}

/** A MAC box's value and where its caret goes. */
export interface MacEdit {
    readonly value: string;
    readonly caret: number;
}

/** Where the caret sits after `digits` hex digits of a formatted value. */
function caretAfter(digits: number): number {
    return digits === 0 ? 0 : digits + Math.floor((digits - 1) / 2);
}

/** `hex` formatted, with the caret after `digits` of it. */
function formatted(hex: string, digits: number): MacEdit {
    const value = (hex.toUpperCase().match(/.{1,2}/g) ?? []).join(":");
    return { value, caret: Math.min(caretAfter(digits), value.length) };
}

/**
 * The box after an edit the browser made: what is in it now and where its caret
 * landed, reformatted.
 *
 * Whatever is not a hex digit is dropped (a colon typed by hand, a letter past
 * F), and the caret keeps the same number of digits before it, so it does not
 * jump when a colon appears or disappears beside it. An edit that would make
 * more than twelve digits is refused and the box stays as it was - typing into
 * a full address does not push its last digit off the end.
 */
export function formatMacInput(raw: string, caret: number, previous: MacEdit): MacEdit {
    const hex = raw.replace(/[^0-9a-f]/gi, "");
    if (hex.length > 12) return previous;
    const before = raw.slice(0, Math.max(0, Math.min(caret, raw.length)));
    return formatted(hex, before.replace(/[^0-9a-f]/gi, "").length);
}

/**
 * Backspace with nothing selected. Over a colon it removes the digit before the
 * colon, which is what anybody pressing it means - a colon is not something they
 * typed, and a Backspace that only stepped over it would look like a key that
 * did nothing. Null when the browser's own Backspace already does the right
 * thing.
 */
export function macBackspace(value: string, caret: number): MacEdit | null {
    if (caret <= 0 || value[caret - 1] !== ":") return null;
    const digits = value.slice(0, caret - 2).replace(/[^0-9a-f]/gi, "").length;
    const hex = (value.slice(0, caret - 2) + value.slice(caret)).replace(/[^0-9a-f]/gi, "");
    return formatted(hex, digits);
}

/** Delete with nothing selected: over a colon it removes the digit after it.
 *  Null when the browser's own Delete already does the right thing. */
export function macDelete(value: string, caret: number): MacEdit | null {
    if (value[caret] !== ":") return null;
    const digits = value.slice(0, caret).replace(/[^0-9a-f]/gi, "").length;
    const hex = (value.slice(0, caret + 1) + value.slice(caret + 2)).replace(/[^0-9a-f]/gi, "");
    return formatted(hex, digits);
}
