import { resolve } from "node:path";
import { loadDotEnv } from "./vitest.env.ts";

export default async function setup() {
  loadDotEnv(resolve(import.meta.dirname, "../.env"));
}
