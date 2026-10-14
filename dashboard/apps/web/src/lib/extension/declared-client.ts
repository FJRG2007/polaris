/**
 * The browser and system an extension says it runs in.
 *
 * The extension names itself "<Browser> on <System>", or just "<Browser>" when
 * it cannot tell the system, and it knows things its user agent hides on
 * purpose: Brave reports a Chrome user agent, so the request alone reads as
 * Chrome. A name is only taken when it is one the extension can send; anything
 * else leaves the user agent's reading in place.
 */

const BROWSERS: ReadonlyMap<string, string> = new Map(
    ["Chrome", "Brave", "Edge", "Opera", "Vivaldi", "Firefox", "Safari"].map((name) => [
        name.toLowerCase(),
        name
    ])
);

const SYSTEMS: ReadonlyMap<string, string> = new Map(
    ["Windows", "macOS", "Linux", "Android", "iOS"].map((name) => [name.toLowerCase(), name])
);

/** What a device name declares, each half null when it declares nothing usable. */
export function declaredClient(name: string | null | undefined): {
    readonly browser: string | null;
    readonly os: string | null;
} {
    const parts = (name ?? "").trim().split(/\s+on\s+/i);
    if (parts.length > 2) return { browser: null, os: null };
    const browser = BROWSERS.get((parts[0] ?? "").trim().toLowerCase()) ?? null;
    if (!browser) return { browser: null, os: null };
    const os = parts.length === 2 ? (SYSTEMS.get(parts[1]!.trim().toLowerCase()) ?? null) : null;
    return { browser, os };
}

/** The browser and system to show for an extension: its declaration where it
 *  made a valid one, the user agent's reading for the rest. */
export function extensionClient(
    name: string | null | undefined,
    fallback: { readonly browser: string; readonly os: string }
): { readonly browser: string; readonly os: string } {
    const declared = declaredClient(name);
    return { browser: declared.browser ?? fallback.browser, os: declared.os ?? fallback.os };
}
