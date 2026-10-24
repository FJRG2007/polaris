// The city's geography, fetched as the compact binary the build ships next to
// the page (`geo-codec.js`), gzip-compressed and decompressed here, so the
// browser never parses a megabyte of JavaScript to read a map. The page names
// the file in `<meta name="geo">`. Every module that imports `GEO` waits on it.
import { decodeGeo } from './geo-codec.js';

async function loadGeo() {
  const src = document.querySelector('meta[name="geo"]')?.getAttribute('content');
  if (!src) throw new Error('No city data named');
  const response = await fetch(src);
  if (!response.ok || !response.body) throw new Error(`City data answered ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  let seen = 0;
  const counted = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (total) parent.postMessage({ type: 'polaris-game:progress', stage: 'data', done: seen / total }, location.origin);
      controller.enqueue(chunk);
    }
  }));
  const bytes = new Uint8Array(await new Response(counted.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  return decodeGeo(bytes);
}

export const GEO = await loadGeo();
