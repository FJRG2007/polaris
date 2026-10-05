/**
 * DON'T depend on anything from the outside like `promiseTry`, as this module is part of a separate lazy-loaded chunk.
 *
 * Including anything from the main chunk would include the whole chunk by default.
 * Even it it would be tree-shaken during build, it won't be tree-shaken in dev.
 *
 * In the future consider separating common utils into a separate shared chunk.
 */

import { Commands, subsetToBinary } from "./subset-shared.chunk";

/**
 * Due to this export (and related dynamic import), this worker code will be included in the bundle automatically (as a separate chunk),
 * without the need for esbuild / vite /rollup plugins and special browser / server treatment.
 *
 * Not set: the editor subsets on the main thread (see `subset-main.ts`), and
 * this module's own URL is not something a host's bundler gives back intact.
 */
export const WorkerUrl: URL | undefined = undefined;

// run only in the worker context
if (typeof window === "undefined" && typeof self !== "undefined") {
  self.onmessage = async (e: {
    data: {
      command: typeof Commands.Subset;
      arrayBuffer: ArrayBuffer;
      codePoints: Array<number>;
    };
  }) => {
    switch (e.data.command) {
      case Commands.Subset:
        const buffer = await subsetToBinary(
          e.data.arrayBuffer,
          e.data.codePoints,
        );

        self.postMessage(buffer, { transfer: [buffer] });
        break;
    }
  };
}
