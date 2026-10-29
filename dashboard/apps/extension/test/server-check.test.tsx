// @vitest-environment jsdom

/**
 * The live "is this a Polaris?" line under the address field: silent while the
 * address is half typed, answered locally when it is malformed, asked once the
 * typing pauses, and never answered with a stale reply for an older address.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddressNote, addable, useAddressCheck } from "../src/entrypoints/popup/server-check";

const asked: string[] = [];
let answers: Record<string, () => Promise<Response>> = {};

function polaris(): Promise<Response> {
    return Promise.resolve(
        new Response(JSON.stringify({ product: "polaris", protocol: 1 }), {
            headers: { "content-type": "application/json" }
        })
    );
}

beforeEach(() => {
    vi.useFakeTimers();
    asked.length = 0;
    answers = {};
    vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
            asked.push(url);
            const answer = answers[new URL(url).host];
            if (answer) return answer();
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
            });
        })
    );
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function Field({ typed }: { typed: string }): React.JSX.Element {
    const check = useAddressCheck(typed);
    return (
        <>
            <AddressNote check={check} />
            <button aria-disabled={!addable(check)}>Add</button>
        </>
    );
}

const button = () => screen.getByRole("button");

describe("useAddressCheck", () => {
    it("says nothing and asks nothing while the address is half typed", async () => {
        render(<Field typed="polaris" />);
        await act(() => vi.advanceTimersByTimeAsync(1_000));
        expect(screen.queryByRole("status")).toBeNull();
        expect(asked).toEqual([]);
        expect(button().getAttribute("aria-disabled")).toBe("true");
    });

    it("answers a malformed address without asking the network", async () => {
        render(<Field typed="ftp://polaris.example.com" />);
        await act(() => vi.advanceTimersByTimeAsync(1_000));
        expect(screen.getByRole("status").textContent).toBe("That does not look like an address.");
        expect(asked).toEqual([]);
    });

    it("waits for the typing to pause, then says it found Polaris and allows Add", async () => {
        answers["one.example.com"] = polaris;
        render(<Field typed="one.example.com" />);
        expect(screen.getByRole("status").textContent).toBe("Checking one.example.com...");
        await act(() => vi.advanceTimersByTimeAsync(399));
        expect(asked).toEqual([]);
        await act(() => vi.advanceTimersByTimeAsync(1));
        expect(screen.getByRole("status").textContent).toBe("Polaris found at one.example.com.");
        expect(button().getAttribute("aria-disabled")).toBe("false");
        expect(asked).toEqual(["https://one.example.com/api/polaris/identity"]);
    });

    it("cancels the question for an address that was typed over", async () => {
        answers["two.example.com"] = polaris;
        const { rerender } = render(<Field typed="slow.example.com" />);
        await act(() => vi.advanceTimersByTimeAsync(400));
        expect(asked).toEqual(["https://slow.example.com/api/polaris/identity"]);
        rerender(<Field typed="two.example.com" />);
        await act(() => vi.advanceTimersByTimeAsync(400));
        expect(screen.getByRole("status").textContent).toBe("Polaris found at two.example.com.");
    });

    it("keeps Add off and says why for a host that is not Polaris", async () => {
        answers["parked.example.com"] = () =>
            Promise.resolve(new Response("<!doctype html>", { headers: { "content-type": "text/html" } }));
        render(<Field typed="parked.example.com" />);
        await act(() => vi.advanceTimersByTimeAsync(400));
        expect(screen.getByRole("status").textContent).toContain("it is not Polaris");
        expect(button().getAttribute("aria-disabled")).toBe("true");
    });

    it("answers an address already asked about at once, without asking again", async () => {
        answers["three.example.com"] = polaris;
        const { rerender } = render(<Field typed="three.example.com" />);
        await act(() => vi.advanceTimersByTimeAsync(400));
        rerender(<Field typed="three.example.co" />);
        rerender(<Field typed="three.example.com" />);
        expect(screen.getByRole("status").textContent).toBe("Polaris found at three.example.com.");
        expect(asked.filter((url) => url.includes("three.example.com/"))).toHaveLength(1);
    });
});
