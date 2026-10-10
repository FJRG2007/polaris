/**
 * The diagram editor Office draws with.
 *
 * Kept inside Polaris:
 * no third-party service is contacted, fonts are served from the host's own
 * origin (`setAssetPath`), the words come from the host's catalogs
 * (`translate`), and the chrome is drawn with Polaris's own tokens.
 *
 * Stylesheet: `@polaris/diagrams/styles.css`.
 */

export {
  Diagram as DiagramCanvas,
  exportToBlob,
  exportToSvg,
  restoreElements,
  CaptureUpdateAction,
  THEME,
  setAssetPath,
} from "./editor/index";
export type { DiagramTranslator } from "./editor/index";
export type {
  DiagramImperativeAPI,
  DiagramProps,
  AppState as DiagramAppState,
  BinaryFiles as DiagramFiles,
} from "./editor/types";
export type { DiagramElement } from "./editor/element/types";
