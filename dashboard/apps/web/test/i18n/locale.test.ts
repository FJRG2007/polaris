/**
 * Which language an account reads in: stored, detected, changed, and told to
 * every tab.
 *
 * The request is faked at its edges - the cookie jar, the headers, the address's
 * country - and everything between is the real code, because the order those
 * are consulted in is the whole rule: the cookie a browser already carries, then
 * what the browser asks for, then the country, then the default. The one case
 * pinned hardest is the slow country lookup, which must not be written down as
 * if it had answered "English".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    locale: string | null;
}

let rows: Record<string, Row> = {};
let cookie: string | undefined;
let acceptLanguage: string | null = null;
let country: string | null | "never" = null;
let session: { id: string } | null = null;

const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => rows[where.id] ?? null);
const update = vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
    rows[where.id] = { ...rows[where.id], ...data } as Row;
    return rows[where.id];
});
const updateMany = vi.fn(
    async ({ where, data }: { where: { id: string; locale: null }; data: Row }) => {
        const row = rows[where.id];
        if (!row || row.locale !== null) return { count: 0 };
        row.locale = data.locale;
        return { count: 1 };
    }
);

vi.mock("@polaris/db", () => ({ prisma: { user: { findUnique, update, updateMany } } }));
vi.mock("next/headers", () => ({
    cookies: async () => ({
        get: (name: string) => (name === "polaris-locale" && cookie ? { value: cookie } : undefined)
    }),
    headers: async () => new Headers(acceptLanguage ? { "accept-language": acceptLanguage } : {})
}));
vi.mock("@/lib/session", () => ({ resolveSession: vi.fn(async () => session) }));
vi.mock("@/lib/request-context", () => ({ clientIp: vi.fn(async () => "203.0.113.9") }));
vi.mock("@/lib/geo-service", () => ({
    resolveGeo: vi.fn(() =>
        country === "never" ? new Promise(() => undefined) : Promise.resolve({ countryCode: country })
    )
}));

/** Fresh modules for every test: the cache lives on globalThis and is cleared
 *  below, and `getLocale` is memoized per request. */
async function modules() {
    vi.resetModules();
    const [request, service, live] = await Promise.all([
        import("@/lib/i18n/request"),
        import("@/lib/i18n/locale-service"),
        import("@/lib/i18n/locale-live")
    ]);
    return { ...request, ...service, ...live };
}

beforeEach(() => {
    rows = { ada: { locale: null }, bob: { locale: "es-ES" } };
    cookie = undefined;
    acceptLanguage = null;
    country = null;
    session = null;
    findUnique.mockClear();
    update.mockClear();
    updateMany.mockClear();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("polaris.locale.cache")];
});

afterEach(() => {
    vi.useRealTimers();
});

describe("detecting the language of a request", () => {
    it("takes the cookie over everything else", async () => {
        cookie = "es-ES";
        acceptLanguage = "en-US";
        const { detectRequestLocale } = await modules();
        expect(await detectRequestLocale({ withCountry: true })).toEqual({ locale: "es-ES", decided: true });
    });

    it("ignores a cookie that names no locale of ours", async () => {
        cookie = "klingon";
        acceptLanguage = "es-MX,es;q=0.9";
        const { detectRequestLocale } = await modules();
        expect((await detectRequestLocale({ withCountry: false })).locale).toBe("es-ES");
    });

    it("reads Accept-Language, weighting it", async () => {
        acceptLanguage = "fr-FR, en;q=0.4, ca;q=0.8";
        const { detectRequestLocale } = await modules();
        expect((await detectRequestLocale({ withCountry: true })).locale).toBe("es-ES");
    });

    it("asks the country only when the browser names nothing Polaris has", async () => {
        acceptLanguage = "fr-FR";
        country = "MX";
        const { detectRequestLocale } = await modules();
        expect(await detectRequestLocale({ withCountry: true })).toEqual({ locale: "es-ES", decided: true });
        country = "FR";
        expect(await detectRequestLocale({ withCountry: true })).toEqual({ locale: "en-US", decided: true });
    });

    it("does not ask the country for somebody signed out", async () => {
        acceptLanguage = "fr-FR";
        country = "ES";
        const { detectRequestLocale } = await modules();
        expect(await detectRequestLocale({ withCountry: false })).toEqual({ locale: "en-US", decided: true });
    });

    it("gives up on a slow country lookup without deciding", async () => {
        vi.useFakeTimers();
        acceptLanguage = "de";
        country = "never";
        const { detectRequestLocale } = await modules();
        const pending = detectRequestLocale({ withCountry: true });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await pending).toEqual({ locale: "en-US", decided: false });
    });
});

describe("an account's language", () => {
    it("is detected and written down on its first request, then only read", async () => {
        session = { id: "ada" };
        acceptLanguage = "es-ES,es;q=0.9";
        const { getLocale } = await modules();
        expect(await getLocale()).toBe("es-ES");
        expect(rows.ada?.locale).toBe("es-ES");
        expect(updateMany).toHaveBeenCalledTimes(1);

        // A later request - a new module, the same account - reads it.
        acceptLanguage = "en-US";
        const again = await modules();
        expect(await again.getLocale()).toBe("es-ES");
        expect(updateMany).toHaveBeenCalledTimes(1);
    });

    it("is not written down when the country lookup ran out of time", async () => {
        vi.useFakeTimers();
        session = { id: "ada" };
        acceptLanguage = "de";
        country = "never";
        const { getLocale } = await modules();
        const pending = getLocale();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await pending).toBe("en-US");
        expect(rows.ada?.locale).toBeNull();
    });

    it("keeps what somebody chose over a detection that raced it", async () => {
        const { recordDetectedLocale } = await modules();
        expect(await recordDetectedLocale("bob", "en-US")).toBe("es-ES");
        expect(rows.bob?.locale).toBe("es-ES");
    });

    it("answers the default for an account with none, without writing anything", async () => {
        const { getUserLocale } = await modules();
        expect(await getUserLocale("ada")).toBe("en-US");
        expect(await getUserLocale("nobody")).toBe("en-US");
        expect(update).not.toHaveBeenCalled();
    });

    it("is read once and then remembered", async () => {
        const { getUserLocale } = await modules();
        await getUserLocale("bob");
        await getUserLocale("bob");
        expect(findUnique).toHaveBeenCalledTimes(1);
    });

    it("changes at once for every reader, and tells the account's tabs", async () => {
        const { getUserLocale, setUserLocale, subscribeLocale } = await modules();
        expect(await getUserLocale("bob")).toBe("es-ES");
        const heard = vi.fn();
        const stop = subscribeLocale(heard);
        await setUserLocale("bob", "en-US");
        stop();
        expect(await getUserLocale("bob")).toBe("en-US");
        expect(heard).toHaveBeenCalledWith({ userId: "bob", locale: "en-US" });
        // The cached answer moved with the write: no read went back for it.
        expect(findUnique).toHaveBeenCalledTimes(1);
    });
});

describe("the live stream", () => {
    it("carries a change of language to that account's tabs and nobody else's", async () => {
        session = { id: "ada" };
        const { publishLocaleChange } = await modules();
        const { GET } = await import("@/app/api/access/stream/route");
        const abort = new AbortController();
        const response = await GET(new Request("http://polaris.local/api/access/stream", { signal: abort.signal }));
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let text = "";
        const readUntil = async (needle: string) => {
            while (!text.includes(needle)) {
                const { value, done } = await reader.read();
                if (done) break;
                text += decoder.decode(value);
            }
        };
        await readUntil(":ok");

        publishLocaleChange({ userId: "bob", locale: "es-ES" });
        publishLocaleChange({ userId: "ada", locale: "es-ES" });
        await readUntil('"kind":"locale"');
        abort.abort();

        const frames = text
            .split("\n\n")
            .filter((frame) => frame.startsWith("data: "))
            .map((frame) => JSON.parse(frame.slice("data: ".length)) as { kind: string; locale: string });
        expect(frames).toEqual([expect.objectContaining({ kind: "locale", locale: "es-ES" })]);
    });
});
