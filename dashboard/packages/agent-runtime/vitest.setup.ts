import { resolve } from "node:path";
import { loadDotEnv } from "./vitest.env.ts";

loadDotEnv(resolve(import.meta.dirname, "../.env"));
