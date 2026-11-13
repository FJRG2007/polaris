// The first-run page: the address is checked by the app (polaris-client), which
// opens it in this window once a Polaris answers there.
const form = document.getElementById("connect");
const field = document.getElementById("address");
const problem = document.getElementById("problem");
const button = document.getElementById("open");

function say(text) {
    problem.textContent = text;
    problem.hidden = !text;
}

field.addEventListener("input", () => {
    say("");
    button.setAttribute("aria-disabled", String(!field.value.trim()));
});
button.setAttribute("aria-disabled", "true");

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!field.value.trim() || button.disabled) return;
    button.disabled = true;
    button.textContent = "Checking...";
    say("");
    try {
        await window.__TAURI__.core.invoke("connect", { address: field.value });
    } catch (error) {
        say(typeof error === "string" ? error : "Could not open that address. Try again.");
        button.disabled = false;
        button.textContent = "Open";
    }
});
