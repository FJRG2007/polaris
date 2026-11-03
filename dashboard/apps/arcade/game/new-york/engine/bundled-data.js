// A data file the build ships next to the page, named by `<meta name="<name>">` (build-games.mjs): the page is served
// from the app bundle, so nothing is fetched from anywhere else. A failure is reported to the host like the city data's.
import { reportFailure } from './embed.js';

export async function fetchBundled(name) {
  try {
    const src = document.querySelector(`meta[name="${name}"]`)?.getAttribute('content');
    if (!src) throw new Error(`No ${name} data named`);
    const response = await fetch(src);
    if (!response.ok) throw new Error(`${name} data answered ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  } catch (e) {
    reportFailure('data');
    throw e;
  }
}
