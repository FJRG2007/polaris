/**
 * The settings screen, loaded as the Stream Deck app loads it, signs what it
 * sends with its own id. The app drops a message signed with the action's id
 * ("from the wrong context"), which left Connect and the timer's fields doing
 * nothing at all.
 */

import { JSDOM } from "jsdom";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const UI = join(__dirname, "..", "io.github.fjrg2007.polaris.sdPlugin", "ui");

type Sent = { event: string; action?: string; context?: string; payload?: Record<string, unknown> };

function openScreen(screen: "key" | "timer") {
    const dom = new JSDOM(
        `<!doctype html><body data-screen="${screen}"><main id="root"></main></body>`,
        {
            runScripts: "outside-only"
        }
    );
    const sent: Sent[] = [];
    const listeners = new Map<string, (event: { data?: string }) => void>();
    class FakeSocket {
        static OPEN = 1;
        readyState = 1;
        addEventListener(type: string, listener: (event: { data?: string }) => void) {
            listeners.set(type, listener);
        }
        send(text: string) {
            sent.push(JSON.parse(text) as Sent);
        }
    }
    Object.assign(dom.window, { WebSocket: FakeSocket });
    // The repository's own two scripts, in the order the page loads them.
    dom.window.eval(readFileSync(join(UI, "words.js"), "utf8"));
    dom.window.eval(readFileSync(join(UI, "pi.js"), "utf8"));
    const action = `io.github.fjrg2007.polaris.${screen}`;
    (
        dom.window as unknown as { connectElgatoStreamDeckSocket: (...args: unknown[]) => void }
    ).connectElgatoStreamDeckSocket(
        1234,
        "inspector-id",
        "registerPropertyInspector",
        JSON.stringify({ application: { language: "en" } }),
        JSON.stringify({ action, context: "action-id", payload: { settings: {} } })
    );
    listeners.get("open")?.({});
    return { dom, sent, listeners, action };
}

describe("the settings screen", () => {
    it("signs Connect with its own id, not the action's", () => {
        const { dom, sent, action, listeners } = openScreen("key");
        // What the plugin answers the screen's hello with.
        listeners.get("message")?.({
            data: JSON.stringify({
                event: "sendToPropertyInspector",
                payload: {
                    type: "status",
                    link: "unset",
                    address: null,
                    account: null,
                    connecting: { phase: "idle" },
                    update: null,
                    catalogue: []
                }
            })
        });
        const input = dom.window.document.querySelector("input");
        input.value = "polaris.example.com";
        input.dispatchEvent(new dom.window.Event("input"));
        const button = [...dom.window.document.querySelectorAll("button")].find((b) => !b.disabled);
        button?.click();

        const connect = sent.find((message) => message.payload?.type === "connect");
        expect(connect).toMatchObject({
            event: "sendToPlugin",
            action,
            context: "inspector-id",
            payload: { type: "connect", address: "polaris.example.com" }
        });
        for (const message of sent.filter((entry) => entry.event !== "registerPropertyInspector")) {
            expect(message.context).toBe("inspector-id");
        }
    });

    it("saves a new timer length signed with its own id", async () => {
        const { dom, sent, action } = openScreen("timer");
        const minutes = dom.window.document.querySelector('input[type="number"]');
        minutes.value = "12";
        minutes.dispatchEvent(new dom.window.Event("input"));
        // Saved a moment after the last keystroke.
        await new Promise((resolve) => setTimeout(resolve, 400));

        expect(sent.find((message) => message.event === "setSettings")).toMatchObject({
            action,
            context: "inspector-id",
            payload: { minutes: 12 }
        });
    });

    it("draws more presses for a key and saves a double press with its window", () => {
        const { dom, sent, listeners } = openScreen("key");
        const fan = (id: string, label: string, kind = "run") => ({
            id,
            kind,
            area: "places",
            label,
            icon: "fan",
            live: false,
            options: []
        });
        const status = (catalogue: unknown[]) =>
            listeners.get("message")?.({
                data: JSON.stringify({
                    event: "sendToPropertyInspector",
                    payload: {
                        type: "status",
                        link: "online",
                        address: "https://polaris.example.com",
                        account: "Ana",
                        connecting: { phase: "idle" },
                        update: null,
                        catalogue
                    }
                })
            });
        status([
            fan("fan.on", "Fan on"),
            fan("fan.off", "Fan off"),
            fan("door", "<img onerror=x>")
        ]);
        listeners.get("message")?.({
            data: JSON.stringify({
                event: "didReceiveSettings",
                context: "action-id",
                payload: { settings: { action: "fan.on" } }
            })
        });
        const document = dom.window.document;
        const double = document.querySelector('select[data-binding="double"]') as HTMLSelectElement;
        expect(double).not.toBeNull();
        expect(document.querySelector('select[data-binding="alternate"]')).not.toBeNull();
        expect(document.querySelector('input[data-window="doubleMs"]')).toBeNull();
        // A label from Polaris stays text.
        expect(document.querySelector("img")).toBeNull();

        double.value = "fan.off";
        double.dispatchEvent(new dom.window.Event("change"));
        const saved = sent.filter((message) => message.event === "setSettings").at(-1);
        expect(saved?.payload).toMatchObject({ action: "fan.on", double: { action: "fan.off" } });
        const window = document.querySelector('input[data-window="doubleMs"]') as HTMLInputElement;
        expect(window.value).toBe("300");

        // A real toggle offers nothing to alternate.
        status([fan("fan.on", "Fan", "toggle"), fan("fan.off", "Fan off")]);
        expect(document.querySelector('select[data-binding="alternate"]')).toBeNull();
        expect(document.querySelector(".gestures")?.textContent).toContain(
            "already switches on and off"
        );
    });
});
