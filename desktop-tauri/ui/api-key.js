// The key form: the app checks the key with the Polaris (GET /api/v1/me) and
// keeps it in the system's password store before it closes this window.
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const t = window.polarisText.t;
const form = document.getElementById("form");
const field = document.getElementById("key");
const problem = document.getElementById("problem");
const submit = document.getElementById("submit");
const reveal = document.getElementById("reveal");

function say(text) {
    problem.textContent = text;
    problem.hidden = !text;
}

field.addEventListener("input", () => {
    say("");
    submit.setAttribute("aria-disabled", String(!field.value.trim()));
});

reveal.addEventListener("click", () => {
    const hidden = field.type === "password";
    field.type = hidden ? "text" : "password";
    reveal.textContent = hidden ? t("key.hide") : t("key.show");
});

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!field.value.trim() || submit.disabled) return;
    submit.disabled = true;
    submit.textContent = t("key.checking");
    say("");
    try {
        await invoke("submit_api_key", { key: field.value });
    } catch (error) {
        say(typeof error === "string" ? error : t("key.check-failed"));
        submit.disabled = false;
        submit.textContent = t("key.save");
    }
});

document.getElementById("cancel").addEventListener("click", () => void invoke("cancel_api_key"));
document.getElementById("open-keys").addEventListener("click", () => void invoke("open_api_keys"));

invoke("api_key_form").then((state) => {
    if (state.server) document.getElementById("server").textContent = new URL(state.server).host;
    if (!state.canKeep) {
        document.getElementById("key-note").textContent = t("key.kept-until-quit");
    }
});
