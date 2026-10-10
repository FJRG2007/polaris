/** Polaris's handwritten face, Playpen Sans (SIL OFL 1.1, TypeTogether) - the one a display name can be set in. */
import Latin from "./PlaypenSans-SemiBold.woff2";
import Greek from "./PlaypenSans-SemiBold-Greek.woff2";
import LatinExt from "./PlaypenSans-SemiBold-LatinExt.woff2";
import Cyrillic from "./PlaypenSans-SemiBold-Cyrillic.woff2";
import Vietnamese from "./PlaypenSans-SemiBold-Vietnamese.woff2";
import CyrillicExt from "./PlaypenSans-SemiBold-CyrillicExt.woff2";

import { GOOGLE_FONTS_RANGES } from "../FontMetadata";

import { type DiagramFontFaceDescriptor } from "../Fonts";

export const HandwrittenFontFaces: DiagramFontFaceDescriptor[] = [
  {
    uri: CyrillicExt,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.CYRILIC_EXT },
  },
  {
    uri: Cyrillic,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.CYRILIC },
  },
  {
    uri: Greek,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.GREEK },
  },
  {
    uri: Vietnamese,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.VIETNAMESE },
  },
  {
    uri: LatinExt,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.LATIN_EXT },
  },
  {
    uri: Latin,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.LATIN },
  },
];
