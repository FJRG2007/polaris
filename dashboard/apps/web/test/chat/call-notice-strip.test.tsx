// @vitest-environment jsdom

/**
 * The call's notices drawn as one line.
 *
 * Reported as four banners stacked over a call when its server went away. What
 * is pinned: one row while closed, the rest behind a "+N" that opens them in
 * place and closes them again, an error announced as an alert and anything else
 * as a status, every action wired to what it fixes, and - from the call's own
 * state - a lost call server folding the microphone notices it explains.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { CallState } from "@/app/(app)/chat/call-state";
import { Wifi, WifiOff, MicOff, Volume1 } from "lucide-react";
import { arbitrateNotices } from "@/app/(app)/chat/call-notices";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_LOST, UNKNOWN_AUDIO } from "@/app/(app)/chat/call-diagnosis";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";

const network = { online: true, slow: false };
const noAudio = { warning: false, dismiss: vi.fn() };
const quiet = { quiet: false, db: 9, atMax: false, turnUp: vi.fn(), dismiss: vi.fn() };
vi.mock("@enigmax/primitives/react/network", () => ({ useNetworkState: () => network }));
vi.mock("@/app/(app)/chat/no-audio-notice", () => ({ useNoAudioWarning: () => noAudio }));
vi.mock("@/app/(app)/chat/quiet-mic-notice", () => ({ useQuietMic: () => quiet }));

const { CallNoticeStrip, useCallNotices } = await import("@/app/(app)/chat/call-notice-strip");
type Shown = import("@/app/(app)/chat/call-notice-strip").ShownNotice;

beforeEach(() => {
    network.slow = false;
    noAudio.warning = false;
    quiet.quiet = false;
    vi.clearAllMocks();
});
afterEach(cleanup);

const rejoin = vi.fn();
const turnUp = vi.fn();

const server: Shown = {
    id: "server",
    severity: "error",
    cause: "server",
    short: "Disconnected from the call",
    full: "This call lost the call server.",
    icon: WifiOff,
    action: { label: "Rejoin call", run: rejoin }
};
const micNotSent: Shown = {
    id: "mic",
    severity: "error",
    cause: "mic-fault",
    short: "Your mic is not being sent",
    full: "Your microphone is open but not being sent.",
    icon: MicOff
};
const slow: Shown = {
    id: "slow",
    severity: "warning",
    cause: "line",
    short: "Slow connection",
    full: "The connection is slow.",
    icon: Wifi
};
const quietMic: Shown = {
    id: "quiet",
    severity: "warning",
    cause: "mic-quiet",
    short: "You sound quieter than others",
    full: "You are 9 dB below everybody else.",
    icon: Volume1,
    action: { label: "Turn up", run: turnUp }
};

function strip(...notices: Shown[]) {
    return render(<CallNoticeStrip order={arbitrateNotices(notices)} />, { wrapper: MessagesWrapper });
}

/** The rows drawn, each one notice. */
const rows = () => screen.getByRole("region", { name: "Call notices" }).querySelectorAll(":scope div.rounded-md");

describe("the call notice strip", () => {
    it("draws nothing when the call has nothing to say", () => {
        const { container } = strip();
        expect(container.innerHTML).toBe("");
    });

    it("is one line with an alert for an error, and no count when there is nothing behind it", () => {
        strip(server);
        expect(rows()).toHaveLength(1);
        const line = screen.getByRole("alert");
        expect(line.textContent).toContain("Disconnected from the call");
        // The whole sentence is read too, and is the title of the words.
        expect(line.textContent).toContain("This call lost the call server.");
        expect(within(line).getByTitle("This call lost the call server.")).toBeTruthy();
        expect(screen.queryByRole("button", { name: /more call notices/ })).toBeNull();
    });

    it("announces a warning as a status, not an alert", () => {
        strip(slow);
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByRole("status").textContent).toContain("Slow connection");
    });

    it("keeps the rest behind +N, opens them in place and closes them again", () => {
        strip(slow, quietMic, server, micNotSent);
        // Server stands; the mic fault, the slow line and the quiet mic follow from it.
        expect(rows()).toHaveLength(1);
        const more = screen.getByRole("button", { name: "Show 3 more call notices" });
        expect(more.textContent).toBe("+3");
        expect(more.getAttribute("aria-expanded")).toBe("false");

        fireEvent.click(more);
        expect(more.getAttribute("aria-expanded")).toBe("true");
        expect(more.getAttribute("aria-label")).toBe("Show fewer call notices");
        expect(rows()).toHaveLength(4);
        expect(screen.getByText("Caused by the first notice")).toBeTruthy();
        const region = screen.getByRole("region", { name: "Call notices" });
        for (const said of [micNotSent, slow, quietMic]) {
            expect(region.textContent).toContain(said.short);
        }

        fireEvent.click(more);
        expect(rows()).toHaveLength(1);
    });

    it("announces what waits behind the line without opening it", () => {
        strip(slow, { ...quietMic, cause: "share", severity: "info" });
        const statuses = screen.getAllByRole("status");
        expect(statuses.some((s) => s.textContent === "You sound quieter than others")).toBe(true);
    });

    it("runs the action beside the words - rejoin on a lost server", () => {
        strip(server);
        fireEvent.click(screen.getByRole("button", { name: "Rejoin call" }));
        expect(rejoin).toHaveBeenCalledTimes(1);
    });

    it("runs the action of a notice opened from behind the count", () => {
        strip(micNotSent, quietMic, { ...slow, cause: "other" });
        fireEvent.click(screen.getByRole("button", { name: /more call notices/ }));
        fireEvent.click(screen.getByRole("button", { name: "Turn up" }));
        expect(turnUp).toHaveBeenCalledTimes(1);
    });

    it("dismisses a notice that can be dismissed", () => {
        const dismiss = vi.fn();
        strip({ ...slow, dismiss });
        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
        expect(dismiss).toHaveBeenCalledTimes(1);
    });
});

/** The call, with only what the notices read. */
function callWith(patch: Partial<CallState>): CallState {
    return {
        error: "",
        audio: UNKNOWN_AUDIO,
        shareStill: false,
        rejoin,
        micOn: true,
        outgoing: null,
        localStream: null,
        ...patch
    } as unknown as CallState;
}

function noticesOf(call: CallState) {
    return renderHook(() => useCallNotices(call), { wrapper: MessagesWrapper }).result.current;
}

describe("the notices a call has", () => {
    it("a lost call server stands alone over the microphone notices it explains", () => {
        noAudio.warning = true;
        quiet.quiet = true;
        network.slow = true;
        const order = noticesOf(
            callWith({
                error: SERVER_LOST,
                audio: {
                    ok: false,
                    blame: "fault",
                    farEnd: false,
                    headline: "Your microphone is not being sent.",
                    fix: "",
                    lines: [],
                    link: "lost",
                    mic: "unpublished"
                }
            })
        );
        expect(order.top?.id).toBe("server");
        expect(order.top?.short).toBe("Disconnected from the call");
        expect(order.rest).toEqual([]);
        expect(order.consequences.map((n) => n.id).sort()).toEqual([
            "diagnosis",
            "no-audio",
            "quiet-mic",
            "slow"
        ]);
        expect(order.mic).toBeNull();
        act(() => order.top?.action?.run());
        expect(rejoin).toHaveBeenCalledTimes(1);
    });

    it("a microphone not being sent marks the microphone and folds its silence", () => {
        noAudio.warning = true;
        const order = noticesOf(
            callWith({
                audio: {
                    ok: false,
                    blame: "fault",
                    farEnd: false,
                    headline: "Your microphone is not being sent.",
                    fix: "",
                    lines: [],
                    link: "connected",
                    mic: "unpublished"
                } as CallState["audio"]
            })
        );
        expect(order.top?.cause).toBe("mic-fault");
        expect(order.mic?.id).toBe("diagnosis");
        expect(order.consequences.map((n) => n.id)).toEqual(["no-audio"]);
    });

    it("a quiet microphone offers to turn it up until it is at the top", () => {
        quiet.quiet = true;
        expect(noticesOf(callWith({})).top?.action?.label).toBe("Turn up");
        cleanup();
        quiet.atMax = true;
        expect(noticesOf(callWith({})).top?.action).toBeUndefined();
        quiet.atMax = false;
    });

    it("an error said in a sentence of its own is drawn as it is", () => {
        const order = noticesOf(callWith({ error: "The camera was refused." }));
        expect(order.top).toMatchObject({ cause: "other", severity: "error", short: "The camera was refused." });
    });

    it("a slow line is only said while there is a line", () => {
        network.slow = true;
        network.online = false;
        expect(noticesOf(callWith({})).top).toBeNull();
        cleanup();
        network.online = true;
        expect(noticesOf(callWith({})).top?.cause).toBe("line");
    });
});
