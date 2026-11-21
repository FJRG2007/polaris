// Browser entry for the OpenMLS wasm build: sizes come from `?sizes=2,50`. Results go to `window.__done`.
import init, { run_size_json } from "../openmls/pkg/openmls_spike.js";

const rows = [];
try {
    const t = performance.now();
    await init();
    rows.push({ step: "wasmInit", ms: performance.now() - t, sinceNavigation: performance.now() });
    const sizes = (new URLSearchParams(location.search).get("sizes") ?? "2,50").split(",").map(Number);
    for (const n of sizes) rows.push(JSON.parse(run_size_json(n, n >= 1000 ? 20 : 50)));
} catch (error) {
    rows.push({ error: String(error) });
}
window.__done = rows;
