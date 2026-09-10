/**
 * The address form: the first run, File > Change server, and where a window that
 * could not load comes back to with the reason.
 *
 * Checked as it is typed against the same schema the main process keeps it
 * with. An empty field is incomplete rather than wrong, so it only disables the
 * button; the reason something is not an address appears once there is text.
 */

import { available, byId, say } from "./dom";
import { serverAddressSchema } from "@/shared/server-address";

const form = byId<HTMLFormElement>("form");
const input = byId<HTMLInputElement>("address");
const submit = byId<HTMLButtonElement>("submit");
const failure = byId<HTMLParagraphElement>("failure");
const note = byId<HTMLSpanElement>("address-note");
const hint = note.textContent ?? "";

let busy = false;

function check(): string | null {
    const text = input.value;
    const parsed = serverAddressSchema.safeParse(text);
    const problem =
        text.trim() && !parsed.success ? (parsed.error.issues[0]?.message ?? null) : null;
    input.setAttribute("aria-invalid", String(Boolean(problem)));
    note.textContent = problem ?? (parsed.success ? `Opens ${parsed.data}` : hint);
    note.className = problem ? "error" : "hint";
    available(submit, parsed.success && !busy);
    return parsed.success ? parsed.data : null;
}

input.addEventListener("input", () => {
    say(failure, null);
    check();
});

form.addEventListener("submit", (event) => {
    event.preventDefault();
    const address = check();
    if (!address || busy) return;
    busy = true;
    submit.textContent = "Checking...";
    check();
    void window.polarisLocal.connect
        .submit(input.value)
        .then((result) => {
            if (!result.ok) say(failure, result.error);
        })
        .catch(() => say(failure, "Something went wrong. Try again."))
        .finally(() => {
            busy = false;
            submit.textContent = "Open";
            check();
        });
});

void window.polarisLocal.connect.state().then((state) => {
    if (state?.address && !input.value) input.value = state.address;
    say(failure, state?.error ?? null);
    check();
});
