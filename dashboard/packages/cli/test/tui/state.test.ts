/**
 * The terminal UI without a terminal: keys through the reducer, the screen
 * read back as text.
 */

import { describe, expect, it } from "vitest";
import { ID, SERVICE } from "../helpers/deploy-server.js";
import { plainText, render } from "../../src/tui/render.js";
import {
    initial,
    nameKey,
    parseKeys,
    reduce,
    top,
    type Event,
    type Key,
    type Project,
    type State,
    type Step
} from "../../src/tui/state.js";

const PROFILES = [
    { name: "home", url: "https://polaris.example.com", account: "ada@example.com", current: true },
    { name: "work", url: "https://work.example.com", account: "ada@work.example", current: false }
];

const PROJECTS: Project[] = [
    {
        id: "p1",
        name: "Shop",
        slug: "shop",
        role: "owner",
        environments: [
            {
                id: "e1",
                name: "Production",
                slug: "production",
                isDefault: true,
                services: [
                    { id: ID, name: "Web", slug: "web", status: "running" },
                    { id: "s2", name: "Worker", slug: "worker", status: "failed" }
                ]
            }
        ]
    },
    { id: "p2", name: "Blog", slug: "blog", role: "member", environments: [] }
];

/** Apply events in order, collecting every effect asked for. */
function play(step: Step, ...events: (Event | Key)[]): { state: State; effects: Step["effects"] } {
    let state = step.state;
    const effects = [...step.effects];
    for (const each of events) {
        const event: Event =
            typeof each === "string" || "char" in each ? { type: "key", key: each } : each;
        const next = reduce(state, event);
        state = next.state;
        effects.push(...next.effects);
    }
    return { state, effects };
}

const screen = (state: State, width = 80, height = 16) => plainText(render(state, width, height));

describe("opening", () => {
    it("asks for a profile when there is more than one and none was named", () => {
        const step = initial(PROFILES, null);
        expect(top(step.state).kind).toBe("profiles");
        expect(step.effects).toEqual([]);
        expect(screen(step.state)).toContain("> home");
    });

    it("goes straight to the projects with one profile, or one named", () => {
        const step = initial(PROFILES, "work");
        expect(top(step.state).kind).toBe("projects");
        expect(step.effects).toEqual([
            { type: "use-profile", name: "work" },
            { type: "load-projects", profile: "work" }
        ]);
    });

    it("picks a profile with Enter and reads its projects", () => {
        const { state, effects } = play(initial(PROFILES, null), "down", "enter");
        expect(state.profile).toBe("work");
        expect(effects).toEqual([
            { type: "use-profile", name: "work" },
            { type: "load-projects", profile: "work" }
        ]);
    });

    it("drops projects read for a profile already left", () => {
        const work = play(initial(PROFILES, null), "down", "enter").state;
        const stale = reduce(work, { type: "projects", profile: "home", projects: PROJECTS });
        expect(stale.state).toBe(work);
    });
});

describe("browsing", () => {
    const loaded = () =>
        play(initial(PROFILES, "home"), { type: "projects", profile: "home", projects: PROJECTS });

    it("projects -> services -> a service, each loading what it shows", () => {
        const { state, effects } = play(
            { state: loaded().state, effects: [] },
            "enter",
            "down",
            "enter"
        );
        expect(top(state)).toEqual({ kind: "service", serviceId: "s2" });
        expect(effects).toEqual([{ type: "load-service", serviceId: "s2" }]);
    });

    it("j and k move like the arrows, and stop at the ends", () => {
        const { state } = play(
            { state: loaded().state, effects: [] },
            "up",
            "up",
            "down",
            "down",
            "down"
        );
        expect(screen(state)).toContain("> Blog");
    });

    it("/ filters the list, Esc clears it", () => {
        const base = { state: loaded().state, effects: [] };
        const filtered = play(base, "filter", { char: "b" }, { char: "l" }, "enter");
        expect(screen(filtered.state)).toContain("> Blog");
        expect(screen(filtered.state)).not.toContain("Shop");
        const cleared = play({ state: filtered.state, effects: [] }, "back");
        expect(screen(cleared.state)).toContain("Shop");
        expect(top(cleared.state).kind).toBe("projects");
    });

    it("while filtering, letters are text rather than commands", () => {
        const filtering = play({ state: loaded().state, effects: [] }, "filter").state;
        expect(nameKey(filtering, "q", { name: "q" })).toEqual({ char: "q" });
        expect(nameKey(loaded().state, "q", { name: "q" })).toBe("quit");
        expect(nameKey(loaded().state, "j", { name: "j" })).toBe("down");
        expect(nameKey(loaded().state, undefined, { name: "c", ctrl: true })).toBe("quit");
    });

    it("Esc goes back a screen, and from the projects to the profiles", () => {
        const into = play({ state: loaded().state, effects: [] }, "enter", "back", "back");
        expect(top(into.state).kind).toBe("profiles");
    });

    it("? shows the keys, any key hides them", () => {
        const help = play({ state: loaded().state, effects: [] }, "help");
        expect(screen(help.state)).toContain("Filter the list");
        expect(play({ state: help.state, effects: [] }, "down").state.help).toBe(false);
    });
});

describe("a service", () => {
    const at = () =>
        play(
            initial(PROFILES, "home"),
            { type: "projects", profile: "home", projects: PROJECTS },
            "enter",
            "enter",
            { type: "service", service: SERVICE }
        );

    it("shows its status, source and domains above what can be done", () => {
        const text = screen(at().state, 100, 20);
        expect(text).toContain("shop/production/web");
        expect(text).toContain("Status:      running");
        expect(text).toContain("shop.example.com -> :3000 (up)");
        expect(text).toContain("> Deployments");
    });

    it("deploys only after y, and No leaves it alone", () => {
        const asked = play({ state: at().state, effects: [] }, "deploy");
        expect(screen(asked.state)).toContain("Deploy shop/production/web again? y to go ahead");
        expect(asked.effects).toEqual([]);
        expect(play({ state: asked.state, effects: [] }, "no").effects).toEqual([]);
        expect(play({ state: asked.state, effects: [] }, "yes").effects).toEqual([
            { type: "run", action: "deploy", serviceId: ID }
        ]);
    });

    it("Enter does not answer the question, and Ctrl+C still quits", () => {
        const asked = play({ state: at().state, effects: [] }, "restart");
        const entered = play({ state: asked.state, effects: [] }, "enter");
        expect(entered.state.confirm).toEqual({ action: "restart", serviceId: ID });
        expect(entered.effects).toEqual([]);
        expect(play({ state: asked.state, effects: [] }, "quit").effects).toEqual([
            { type: "quit" }
        ]);
    });

    it("rows read for another service are not shown as this one's", () => {
        const deployments = play({ state: at().state, effects: [] }, "enter").state;
        const stale = reduce(deployments, {
            type: "deployments",
            serviceId: "s2",
            deployments: []
        });
        expect(stale.state).toBe(deployments);
        const variables = play({ state: at().state, effects: [] }, "down", "down", "enter").state;
        expect(reduce(variables, { type: "variables", serviceId: "s2", variables: [] }).state).toBe(
            variables
        );
    });

    it("restart from the menu is confirmed too", () => {
        const menu = play(
            { state: at().state, effects: [] },
            "down",
            "down",
            "down",
            "down",
            "enter"
        );
        expect(menu.state.confirm).toEqual({ action: "restart", serviceId: ID });
    });

    it("an answer for a service already left is dropped", () => {
        const left = play({ state: at().state, effects: [] }, "back").state;
        const stale = reduce(left, { type: "service", service: { ...SERVICE, id: "gone" } });
        expect(stale.state).toBe(left);
    });

    it("variables show names and mask secrets; values are never there to show", () => {
        const env = play({ state: at().state, effects: [] }, "down", "down", "enter", {
            type: "variables",
            serviceId: ID,
            variables: [{ key: "DATABASE_URL", isSecret: true, updatedAt: "2026-10-04" }]
        });
        expect(env.effects).toEqual([{ type: "load-variables", serviceId: ID }]);
        expect(screen(env.state)).toContain("DATABASE_URL  secret  ******");
    });

    it("the log follows, appends and stops following on the way out", () => {
        const log = play(
            { state: at().state, effects: [] },
            "down",
            "enter",
            { type: "log", text: "one\ntwo\n", append: false },
            { type: "log", text: "three\n", append: true }
        );
        expect(log.effects).toEqual([{ type: "follow-log", serviceId: ID }]);
        expect(screen(log.state)).toMatch(/one\ntwo\nthree/);
        expect(play({ state: log.state, effects: [] }, "back").effects).toEqual([
            { type: "stop-log" }
        ]);
    });

    it("a failure is a line at the bottom, not a crash", () => {
        const failed = play(
            { state: at().state, effects: [] },
            {
                type: "failed",
                text: "Polaris refused: you may not deploy this service."
            }
        );
        expect(screen(failed.state)).toContain("Polaris refused: you may not deploy this service.");
    });
});

describe("reading keys", () => {
    it("names arrows, Enter, a lone Esc, Backspace and Ctrl+C", () => {
        expect(parseKeys("\u001b[A\u001bOB\r\u001b\u007f\u0003j")).toEqual([
            { name: "up" },
            { name: "down" },
            { name: "return" },
            { name: "escape" },
            { name: "backspace" },
            { name: "c", ctrl: true },
            { text: "j" }
        ]);
    });

    it("reads CRLF as one Enter", () => {
        expect(parseKeys("\r\n\n\r")).toEqual([
            { name: "return" },
            { name: "return" },
            { name: "return" }
        ]);
    });

    it("drops escape sequences that are not keys here", () => {
        expect(parseKeys("\u001b[H\u001b[200~x")).toEqual([{ text: "x" }]);
    });
});

describe("drawing", () => {
    it("fills the window exactly, and cuts long lines rather than wrapping them", () => {
        const step = play(initial(PROFILES, "home"), {
            type: "projects",
            profile: "home",
            projects: [{ ...PROJECTS[0]!, name: "x".repeat(300) }]
        });
        const lines = render(step.state, 40, 10);
        expect(lines).toHaveLength(10);
        for (const each of plainText(lines).split("\n"))
            expect(each.length).toBeLessThanOrEqual(40);
    });

    it("draws ASCII only", () => {
        const text = screen(play(initial(PROFILES, null)).state);
        expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
    });
});
