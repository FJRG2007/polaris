// @vitest-environment jsdom

/**
 * A password set in game shows up on the players table without a reload.
 *
 * The table reads who has a Polaris login password from the login state the
 * panel keeps, which used to be read again once a minute and never on coming
 * back to the tab: a player who joined and set one sat under "no password yet"
 * for as long as the operator watched, though the same row already said they
 * were online. The state is now read every few seconds while somebody on has no
 * password, every half minute otherwise, at once when the tab is looked at
 * again, and swapped in only when it changed.
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { MinecraftStatus } from "@polaris-app/game-servers/src/lib/minecraft/service";
import type { LoginState } from "@polaris-app/game-servers/src/lib/minecraft/polaris-login-service";
import { MinecraftPlayers } from "@polaris-app/game-servers/src/screens/installed/minecraft-players";
import * as loginActions from "@polaris-app/game-servers/src/screens/installed/minecraft-login-actions";
import {
    awaitingPassword,
    LOGIN_IDLE_MS,
    LOGIN_LIVE_MS,
    useLoginState
} from "@polaris-app/game-servers/src/screens/installed/minecraft-polaris-login";
// The dashboard's pieces the screen takes, as the layout provides them.
import "@/components/app-host/client";
import { dropSnapshots } from "@/lib/snapshot-cache";

vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-actions", () => ({}));
// Reached through the row dialogs' imports; nothing here signs anybody in.
vi.mock("@/lib/session", () => ({}));
vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-login-actions", () => ({
    loginStateAction: vi.fn(),
    setLoginAction: vi.fn(),
    forgetLoginAction: vi.fn()
}));

const SERVER = "00000000-0000-4000-8000-000000000001";

const STATUS: MinecraftStatus = {
    edition: "java",
    running: true,
    containerRunning: true,
    crashLoop: null,
    answering: true,
    players: { online: 1, max: 20, players: ["Steve"] },
    address: "mc.example.com",
    message: null,
    cpuPercent: null,
    memUsedBytes: null,
    memTotalBytes: null
};

function loginState(players: LoginState["players"]): LoginState {
    return {
        on: true,
        build: "polaris-login-paper.jar",
        foreign: null,
        reachable: true,
        health: "ok",
        seenAt: "2026-10-04T10:00:00.000Z",
        modVersion: "1.0.0",
        currentVersion: "1.0.0",
        outdated: false,
        players
    };
}

const NOBODY = loginState([]);
const STEVE = loginState([
    {
        name: "Steve",
        createdAt: "2026-10-04T10:00:05.000Z",
        lastLoginAt: "2026-10-04T10:00:05.000Z"
    }
]);

/** The players table wired to the login state the way the panel wires it. */
function LivePlayers({ initial }: { initial: LoginState | null }) {
    const names = STATUS.players.players;
    const login = useLoginState(SERVER, initial, true, (held) =>
        awaitingPassword(held, names) ? LOGIN_LIVE_MS : LOGIN_IDLE_MS
    );
    return (
        <MinecraftPlayers
            installedAppId={SERVER}
            status={STATUS}
            roster={{ ops: [], whitelist: [], bans: [], whitelistEnforced: true }}
            rosterAsOf={null}
            access={{
                rules: [],
                bindAddresses: true,
                addressesAvailable: true,
                edition: "java",
                refusals: [],
                links: []
            }}
            sessions={[]}
            seen={{}}
            now={Date.now()}
            timeouts={[]}
            levels={{}}
            lastLevels={{}}
            pending={[]}
            passwords={login.state?.on ? login.state.players : null}
            onPasswordsChanged={() => void login.reload()}
            onChanged={vi.fn()}
        />
    );
}

function steveRow(): HTMLElement {
    const row = screen.getByTitle("Steve").closest("tr");
    if (!row) throw new Error("no row for Steve");
    return row;
}

let hidden = false;

async function pass(ms: number): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

beforeEach(() => {
    hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    vi.useFakeTimers();
    dropSnapshots("minecraft-login:");
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
});

describe("a password set in game on the players table", () => {
    it("turns no password yet into password set without a reload", async () => {
        vi.mocked(loginActions.loginStateAction).mockResolvedValue({ state: STEVE });
        render(<LivePlayers initial={NOBODY} />);
        await pass(0);
        // What the page was rendered with paints at once; nothing is asked again.
        expect(within(steveRow()).getByText("no password yet")).toBeTruthy();
        expect(loginActions.loginStateAction).not.toHaveBeenCalled();

        // Steve is on without one, so the next read is a few seconds away.
        await pass(LOGIN_LIVE_MS);
        expect(loginActions.loginStateAction).toHaveBeenCalledTimes(1);
        expect(within(steveRow()).getByText("password set")).toBeTruthy();
        expect(within(steveRow()).queryByText("no password yet")).toBeNull();
    });

    it("slows down once everybody on has one, without asking twice for it", async () => {
        vi.mocked(loginActions.loginStateAction).mockResolvedValue({ state: STEVE });
        render(<LivePlayers initial={NOBODY} />);
        await pass(LOGIN_LIVE_MS);
        expect(loginActions.loginStateAction).toHaveBeenCalledTimes(1);

        // The answer changed the cadence; the same question is not asked again
        // at once, nor at the quick beat.
        await pass(LOGIN_LIVE_MS);
        expect(loginActions.loginStateAction).toHaveBeenCalledTimes(1);
        await pass(LOGIN_IDLE_MS - LOGIN_LIVE_MS);
        expect(loginActions.loginStateAction).toHaveBeenCalledTimes(2);
    });

    it("keeps the row as it was while a read is out, and when one fails", async () => {
        let answer: (value: { state?: LoginState; error?: string }) => void = () => {};
        vi.mocked(loginActions.loginStateAction).mockImplementationOnce(
            () => new Promise((resolve) => (answer = resolve))
        );
        render(<LivePlayers initial={NOBODY} />);
        await pass(LOGIN_LIVE_MS);
        expect(within(steveRow()).getByText("no password yet")).toBeTruthy();
        await act(async () => answer({ state: STEVE }));
        expect(within(steveRow()).getByText("password set")).toBeTruthy();

        vi.mocked(loginActions.loginStateAction).mockRejectedValueOnce(new Error("offline"));
        await pass(LOGIN_IDLE_MS);
        expect(within(steveRow()).getByText("password set")).toBeTruthy();
    });

    it("reads at once when the tab is looked at again, and nothing while hidden", async () => {
        vi.mocked(loginActions.loginStateAction).mockResolvedValue({ state: NOBODY });
        render(<LivePlayers initial={NOBODY} />);
        await pass(0);

        hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
        await pass(LOGIN_IDLE_MS * 2);
        // The beat that was already set fires once and stops there.
        const whileHidden = vi.mocked(loginActions.loginStateAction).mock.calls.length;
        expect(whileHidden).toBeLessThanOrEqual(1);

        vi.mocked(loginActions.loginStateAction).mockResolvedValue({ state: STEVE });
        hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
        await pass(0);
        expect(loginActions.loginStateAction).toHaveBeenCalledTimes(whileHidden + 1);
        expect(within(steveRow()).getByText("password set")).toBeTruthy();
    });

    it("keeps the beat when the tab is back moments after a read answered while hidden", async () => {
        let answer: (value: { state?: LoginState; error?: string }) => void = () => {};
        vi.mocked(loginActions.loginStateAction).mockImplementationOnce(
            () => new Promise((resolve) => (answer = resolve))
        );
        render(<LivePlayers initial={NOBODY} />);
        await pass(LOGIN_LIVE_MS);
        expect(loginActions.loginStateAction).toHaveBeenCalledTimes(1);

        hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
        await act(async () => answer({ state: NOBODY }));
        hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
        await pass(0);
        expect(loginActions.loginStateAction).toHaveBeenCalledTimes(1);

        vi.mocked(loginActions.loginStateAction).mockResolvedValue({ state: STEVE });
        await pass(LOGIN_LIVE_MS);
        expect(loginActions.loginStateAction).toHaveBeenCalledTimes(2);
        expect(within(steveRow()).getByText("password set")).toBeTruthy();
    });

    it("reads at once when the window is focused again from the game", async () => {
        vi.mocked(loginActions.loginStateAction).mockResolvedValue({ state: STEVE });
        render(<LivePlayers initial={NOBODY} />);
        await pass(1_000);
        expect(loginActions.loginStateAction).not.toHaveBeenCalled();

        await pass(2_000);
        window.dispatchEvent(new Event("focus"));
        await pass(0);
        expect(loginActions.loginStateAction).toHaveBeenCalledTimes(1);
        expect(within(steveRow()).getByText("password set")).toBeTruthy();
    });
});

describe("useLoginState", () => {
    let reloadNow: () => Promise<void> = async () => {};

    function Probe({ seen }: { seen: (state: LoginState | null) => void }): ReactNode {
        const login = useLoginState(SERVER, null, true, LOGIN_IDLE_MS);
        reloadNow = login.reload;
        seen(login.state);
        return null;
    }

    it("keeps what it holds when an answer is the same", async () => {
        vi.mocked(loginActions.loginStateAction).mockImplementation(async () => ({
            state: loginState([])
        }));
        const states: (LoginState | null)[] = [];
        render(<Probe seen={(state) => states.push(state)} />);
        await pass(0);
        const first = states.at(-1);
        expect(first?.on).toBe(true);
        await pass(LOGIN_IDLE_MS);
        expect(loginActions.loginStateAction).toHaveBeenCalledTimes(2);
        expect(states.at(-1)).toBe(first);
    });

    it("drops an answer older than one already on screen", async () => {
        const answers: ((value: { state: LoginState }) => void)[] = [];
        vi.mocked(loginActions.loginStateAction).mockImplementation(
            () => new Promise((resolve) => answers.push(resolve))
        );
        const states: (LoginState | null)[] = [];
        render(<Probe seen={(state) => states.push(state)} />);
        await pass(0);
        expect(answers).toHaveLength(1);
        // A reset asks again while the beat's read is still out, and its answer
        // - the newer one - comes back first.
        await act(async () => void reloadNow());
        expect(answers).toHaveLength(2);
        await act(async () => answers[1]!({ state: STEVE }));
        expect(states.at(-1)?.players).toHaveLength(1);
        await act(async () => answers[0]!({ state: NOBODY }));
        expect(states.at(-1)?.players).toHaveLength(1);
    });
});

describe("awaitingPassword", () => {
    it("is true only while somebody on has none, with the mod on", () => {
        expect(awaitingPassword(NOBODY, ["Steve"])).toBe(true);
        expect(awaitingPassword(STEVE, ["steve"])).toBe(false);
        expect(awaitingPassword(STEVE, [])).toBe(false);
        expect(awaitingPassword({ ...NOBODY, on: false }, ["Steve"])).toBe(false);
        expect(awaitingPassword(null, ["Steve"])).toBe(false);
    });
});
