/**
 * The key form: shown the first time a push needs a key, checked against the
 * instance before it is kept.
 */

import { available, byId, say } from "./dom";
import { apiKeySchema } from "@/shared/api-key";

const form = byId<HTMLFormElement>("form");
const input = byId<HTMLInputElement>("key");
const reveal = byId<HTMLButtonElement>("reveal");
const submit = byId<HTMLButtonElement>("submit");
const failure = byId<HTMLParagraphElement>("failure");
const note = byId<HTMLSpanElement>("key-note");

let busy = false;

function check(): boolean {
    const parsed = apiKeySchema.safeParse(input.value);
    const problem = input.value.trim() && !parsed.success ? (parsed.error.issues[0]?.message ?? null) : null;
    input.setAttribute("aria-invalid", String(Boolean(problem)));
    say(failure, problem);
    available(submit, parsed.success && !busy);
    return parsed.success;
}

input.addEventListener("input", check);

reveal.addEventListener("click", () => {
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    reveal.textContent = hidden ? "Hide" : "Show";
});

form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!check() || busy) return;
    busy = true;
    submit.textContent = "Checking...";
    check();
    void window.polarisLocal.apiKey
        .submit(input.value)
        .then((result) => {
            if (!result.ok) say(failure, result.error);
        })
        .catch(() => say(failure, "Something went wrong. Try again."))
        .finally(() => {
            busy = false;
            submit.textContent = "Save key";
            available(submit, apiKeySchema.safeParse(input.value).success);
        });
});

byId<HTMLButtonElement>("cancel").addEventListener("click", () => void window.polarisLocal.apiKey.cancel());
byId<HTMLButtonElement>("open-keys").addEventListener("click", () => void window.polarisLocal.apiKey.openKeys());

void window.polarisLocal.apiKey.state().then((state) => {
    if (!state) return;
    if (state.server) byId<HTMLSpanElement>("server").textContent = new URL(state.server).host;
    if (!state.canKeep) {
        note.textContent =
            "This computer has no password store the app can use, so the key is kept only until the app quits.";
    }
});
