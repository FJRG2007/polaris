/**
 * Whether what somebody typed into a search box is an address to open, and
 * which one. Shared by the dashboard's palette and the desktop launcher, so
 * both offer "Open <host>" for the same text.
 *
 * The rules follow Flow Launcher's Url plugin: `http(s)://` and `mailto:` are
 * taken as typed; a bare domain gets `https://`, and `localhost`, an IPv4
 * address or a bracketed IPv6 address gets `http://`. Anything with a space,
 * a plain number ("1.5"), or any other scheme (`file:`, `javascript:`, an
 * app's own) is never an address here: typed text must not open those.
 */

export interface TypedUrl {
    /** The address to open, always `http:`, `https:` or `mailto:`. */
    readonly url: string;
    /** What the row names: the host, or the mail address. */
    readonly host: string;
}

const MAX_LENGTH = 2048;
const PORT = "(?::\\d{1,5})?";
const REST = "(?:[/?#]\\S*)?";
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** A domain: labels with a top-level one of two letters or more. */
const DOMAIN = new RegExp(String.raw`^(?:${LABEL}\.)+[a-z]{2,63}${PORT}${REST}$`, "i");
const LOCALHOST = new RegExp(String.raw`^localhost${PORT}${REST}$`, "i");
const IPV4 = new RegExp(String.raw`^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})${PORT}${REST}$`);
const IPV6 = new RegExp(String.raw`^\[[0-9a-f:.]+\]${PORT}${REST}$`, "i");
const MAIL = /^[^\s@/:]+@[^\s@/:]+\.[a-z]{2,63}$/i;

/** The address `text` names, or null when it is not one to open. */
export function typedUrl(text: string): TypedUrl | null {
    const value = text.trim();
    if (!value || value.length > MAX_LENGTH || /\s/.test(value)) return null;
    if (/^mailto:/i.test(value)) {
        const address = value.slice("mailto:".length).split("?")[0] ?? "";
        return MAIL.test(decodeSafe(address)) ? parsed(value, decodeSafe(address)) : null;
    }
    if (/^https?:\/\//i.test(value)) return web(value);
    if (LOCALHOST.test(value) || IPV6.test(value) || ipv4(value)) return web(`http://${value}`);
    // "localhost:3000" was handled above; any other "word:" is a scheme, refused.
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(value)) return null;
    if (DOMAIN.test(value)) return web(`https://${value}`);
    return null;
}

function ipv4(value: string): boolean {
    const match = IPV4.exec(value);
    return Boolean(match && match.slice(1, 5).every((part) => Number(part) <= 255));
}

function web(value: string): TypedUrl | null {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.username || url.password) return null;
    return { url: url.href, host: url.host };
}

function parsed(value: string, host: string): TypedUrl | null {
    try {
        return { url: new URL(value).href, host };
    } catch {
        return null;
    }
}

function decodeSafe(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
