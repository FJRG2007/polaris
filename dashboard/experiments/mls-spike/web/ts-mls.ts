/** Browser entry for ts-mls: sizes come from `?sizes=2,50`. Results go to `window.__done`. */
import * as bench from "../src/bench";

const ready = performance.now();
const sizes = (new URLSearchParams(location.search).get("sizes") ?? "2,50").split(",").map(Number);
const rows: unknown[] = [{ step: "scriptEvaluatedSinceNavigation", ms: ready }];
bench
    .runAll(sizes, (row) => rows.push(row))
    .then(() => Object.assign(window, { __done: rows }))
    .catch((error: unknown) => Object.assign(window, { __done: [...rows, { error: String(error) }] }));
