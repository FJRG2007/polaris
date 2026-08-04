import { resolve } from "node:path";
import { config } from "dotenv";

export default async function setup() {
  config({ path: resolve(import.meta.dirname, "../.env") });
}
