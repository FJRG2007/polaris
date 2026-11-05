// @vitest-environment jsdom

/**
 * The batched tag lookup: a change of tag is asked again for every name still
 * on screen, without blanking what is drawn meanwhile, and a signed-out
 * reader's refusal is kept rather than asked for on every draw.
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ALICE = "00000000-0000-4000-8000-000000000001";
const tagOf = (text: string) => ({
    text,
    emblem: "spark",
    color: "blue",
    orgId: null,
    image: null
});

let answer: () => Response;
const fetchMock = vi.fn(async () => answer());

async function settle(): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
    });
}

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("name tag store", () => {
    it("asks again for the names on screen after a change, keeping the old tag meanwhile", async () => {
        const store = await import("@/components/name-tags/name-tag-store");
        answer = () => Response.json({ tags: { [ALICE]: tagOf("ACME") } });
        const { result } = renderHook(() => store.useNameTag(ALICE));
        await settle();
        expect(result.current?.text).toBe("ACME");

        answer = () => Response.json({ tags: { [ALICE]: tagOf("NEW") } });
        act(() => store.forgetNameTags());
        expect(result.current?.text).toBe("ACME");
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.current?.text).toBe("NEW");
    });

    it("keeps a signed-out refusal instead of asking on every draw", async () => {
        const store = await import("@/components/name-tags/name-tag-store");
        answer = () => Response.json({ error: "unauthorized" }, { status: 401 });
        const first = renderHook(() => store.useNameTag(ALICE));
        await settle();
        first.unmount();
        renderHook(() => store.useNameTag(ALICE));
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
