/** Node runner: `node src/node.ts 2 50 500`. Prints one JSON line per step. */
const started = performance.now();
const bench = await import("./bench.ts");
console.log(JSON.stringify({ step: "import", ms: performance.now() - started }));
const sizes = process.argv.slice(2).map(Number);
await bench.runAll(sizes.length ? sizes : [2, 50], (row) => console.log(JSON.stringify(row)));
