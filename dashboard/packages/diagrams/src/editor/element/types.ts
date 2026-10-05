import type { LocalPoint, Radians } from "../../math";
import type {
  FONT_FAMILY,
  ROUNDNESS,
  TEXT_ALIGN,
  THEME,
  VERTICAL_ALIGN,
} from "../constants";
import type {
  MakeBrand,
  MarkNonNullable,
  Merge,
  ValueOf,
} from "../utility-types";

export type ChartType = "bar" | "line";
export type FillStyle = "hachure" | "cross-hatch" | "solid" | "zigzag";
export type FontFamilyKeys = keyof typeof FONT_FAMILY;
export type FontFamilyValues = typeof FONT_FAMILY[FontFamilyKeys];
export type Theme = typeof THEME[keyof typeof THEME];
export type FontString = string & { _brand: "fontString" };
export type GroupId = string;
export type PointerType = "mouse" | "pen" | "touch";
export type StrokeRoundness = "round" | "sharp";
export type RoundnessType = ValueOf<typeof ROUNDNESS>;
export type StrokeStyle = "solid" | "dashed" | "dotted";
export type TextAlign = typeof TEXT_ALIGN[keyof typeof TEXT_ALIGN];

type VerticalAlignKeys = keyof typeof VERTICAL_ALIGN;
export type VerticalAlign = typeof VERTICAL_ALIGN[VerticalAlignKeys];
export type FractionalIndex = string & { _brand: "franctionalIndex" };

export type BoundElement = Readonly<{
  id: DiagramLinearElement["id"];
  type: "arrow" | "text";
}>;

type _DiagramElementBase = Readonly<{
  id: string;
  x: number;
  y: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: FillStyle;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  roundness: null | { type: RoundnessType; value?: number };
  roughness: number;
  opacity: number;
  width: number;
  height: number;
  angle: Radians;
  /** Random integer used to seed shape generation so that the roughjs shape
      doesn't differ across renders. */
  seed: number;
  /** Integer that is sequentially incremented on each change. Used to reconcile
      elements during collaboration or when saving to server. */
  version: number;
  /** Random integer that is regenerated on each change.
      Used for deterministic reconciliation of updates during collaboration,
      in case the versions (see above) are identical. */
  versionNonce: number;
  /** String in a fractional form defined by https://github.com/rocicorp/fractional-indexing.
      Used for ordering in multiplayer scenarios, such as during reconciliation or undo / redo.
      Always kept in sync with the array order by `syncMovedIndices` and `syncInvalidIndices`.
      Could be null, i.e. for new elements which were not yet assigned to the scene. */
  index: FractionalIndex | null;
  isDeleted: boolean;
  /** List of groups the element belongs to.
      Ordered from deepest to shallowest. */
  groupIds: readonly GroupId[];
  frameId: string | null;
  /** other elements that are bound to this element */
  boundElements: readonly BoundElement[] | null;
  /** epoch (ms) timestamp of last element update */
  updated: number;
  link: string | null;
  locked: boolean;
  customData?: Record<string, any>;
}>;

export type DiagramSelectionElement = _DiagramElementBase & {
  type: "selection";
};

export type DiagramRectangleElement = _DiagramElementBase & {
  type: "rectangle";
};

export type DiagramDiamondElement = _DiagramElementBase & {
  type: "diamond";
};

export type DiagramEllipseElement = _DiagramElementBase & {
  type: "ellipse";
};

export type DiagramEmbeddableElement = _DiagramElementBase &
  Readonly<{
    type: "embeddable";
  }>;

export type MagicGenerationData =
  | {
      status: "pending";
    }
  | { status: "done"; html: string }
  | {
      status: "error";
      message?: string;
      code: "ERR_GENERATION_INTERRUPTED" | string;
    };

export type DiagramIframeElement = _DiagramElementBase &
  Readonly<{
    type: "iframe";
    // TODO move later to AI-specific frame
    customData?: { generationData?: MagicGenerationData };
  }>;

export type DiagramIframeLikeElement =
  | DiagramIframeElement
  | DiagramEmbeddableElement;

export type IframeData =
  | {
      intrinsicSize: { w: number; h: number };
      error?: Error;
      sandbox?: { allowSameOrigin?: boolean };
    } & (
      | { type: "video" | "generic"; link: string }
      | { type: "document"; srcdoc: (theme: Theme) => string }
    );

export type ImageCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
};

export type DiagramImageElement = _DiagramElementBase &
  Readonly<{
    type: "image";
    fileId: FileId | null;
    /** whether respective file is persisted */
    status: "pending" | "saved" | "error";
    /** X and Y scale factors <-1, 1>, used for image axis flipping */
    scale: [number, number];
    /** whether an element is cropped */
    crop: ImageCrop | null;
  }>;

export type InitializedDiagramImageElement = MarkNonNullable<
  DiagramImageElement,
  "fileId"
>;

export type DiagramFrameElement = _DiagramElementBase & {
  type: "frame";
  name: string | null;
};

export type DiagramMagicFrameElement = _DiagramElementBase & {
  type: "magicframe";
  name: string | null;
};

export type DiagramFrameLikeElement =
  | DiagramFrameElement
  | DiagramMagicFrameElement;

/**
 * These are elements that don't have any additional properties.
 */
export type DiagramGenericElement =
  | DiagramSelectionElement
  | DiagramRectangleElement
  | DiagramDiamondElement
  | DiagramEllipseElement;

export type DiagramFlowchartNodeElement =
  | DiagramRectangleElement
  | DiagramDiamondElement
  | DiagramEllipseElement;

export type DiagramRectanguloidElement =
  | DiagramRectangleElement
  | DiagramImageElement
  | DiagramTextElement
  | DiagramFreeDrawElement
  | DiagramIframeLikeElement
  | DiagramFrameLikeElement
  | DiagramEmbeddableElement;

/**
 * DiagramElement should be JSON serializable and (eventually) contain
 * no computed data. The list of all DiagramElements should be shareable
 * between peers and contain no state local to the peer.
 */
export type DiagramElement =
  | DiagramGenericElement
  | DiagramTextElement
  | DiagramLinearElement
  | DiagramArrowElement
  | DiagramFreeDrawElement
  | DiagramImageElement
  | DiagramFrameElement
  | DiagramMagicFrameElement
  | DiagramIframeElement
  | DiagramEmbeddableElement;

export type DiagramNonSelectionElement = Exclude<
  DiagramElement,
  DiagramSelectionElement
>;

export type Ordered<TElement extends DiagramElement> = TElement & {
  index: FractionalIndex;
};

export type OrderedDiagramElement = Ordered<DiagramElement>;

export type NonDeleted<TElement extends DiagramElement> = TElement & {
  isDeleted: boolean;
};

export type NonDeletedDiagramElement = NonDeleted<DiagramElement>;

export type DiagramTextElement = _DiagramElementBase &
  Readonly<{
    type: "text";
    fontSize: number;
    fontFamily: FontFamilyValues;
    text: string;
    textAlign: TextAlign;
    verticalAlign: VerticalAlign;
    containerId: DiagramGenericElement["id"] | null;
    originalText: string;
    /**
     * If `true` the width will fit the text. If `false`, the text will
     * wrap to fit the width.
     *
     * @default true
     */
    autoResize: boolean;
    /**
     * Unitless line height (aligned to W3C). To get line height in px, multiply
     *  with font size (using `getLineHeightInPx` helper).
     */
    lineHeight: number & { _brand: "unitlessLineHeight" };
  }>;

export type DiagramBindableElement =
  | DiagramRectangleElement
  | DiagramDiamondElement
  | DiagramEllipseElement
  | DiagramTextElement
  | DiagramImageElement
  | DiagramIframeElement
  | DiagramEmbeddableElement
  | DiagramFrameElement
  | DiagramMagicFrameElement;

export type DiagramTextContainer =
  | DiagramRectangleElement
  | DiagramDiamondElement
  | DiagramEllipseElement
  | DiagramArrowElement;

export type DiagramTextElementWithContainer = {
  containerId: DiagramTextContainer["id"];
} & DiagramTextElement;

export type FixedPoint = [number, number];

export type PointBinding = {
  elementId: DiagramBindableElement["id"];
  focus: number;
  gap: number;
};

export type FixedPointBinding = Merge<
  PointBinding,
  {
    // Represents the fixed point binding information in form of a vertical and
    // horizontal ratio (i.e. a percentage value in the 0.0-1.0 range). This ratio
    // gives the user selected fixed point by multiplying the bound element width
    // with fixedPoint[0] and the bound element height with fixedPoint[1] to get the
    // bound element-local point coordinate.
    fixedPoint: FixedPoint;
  }
>;

export type Arrowhead =
  | "arrow"
  | "bar"
  | "dot" // legacy. Do not use for new elements.
  | "circle"
  | "circle_outline"
  | "triangle"
  | "triangle_outline"
  | "diamond"
  | "diamond_outline"
  | "crowfoot_one"
  | "crowfoot_many"
  | "crowfoot_one_or_many";

export type DiagramLinearElement = _DiagramElementBase &
  Readonly<{
    type: "line" | "arrow";
    points: readonly LocalPoint[];
    lastCommittedPoint: LocalPoint | null;
    startBinding: PointBinding | null;
    endBinding: PointBinding | null;
    startArrowhead: Arrowhead | null;
    endArrowhead: Arrowhead | null;
  }>;

export type FixedSegment = {
  start: LocalPoint;
  end: LocalPoint;
  index: number;
};

export type DiagramArrowElement = DiagramLinearElement &
  Readonly<{
    type: "arrow";
    elbowed: boolean;
  }>;

export type DiagramElbowArrowElement = Merge<
  DiagramArrowElement,
  {
    elbowed: true;
    startBinding: FixedPointBinding | null;
    endBinding: FixedPointBinding | null;
    fixedSegments: readonly FixedSegment[] | null;
    /**
     * Marks that the 3rd point should be used as the 2nd point of the arrow in
     * order to temporarily hide the first segment of the arrow without losing
     * the data from the points array. It allows creating the expected arrow
     * path when the arrow with fixed segments is bound on a horizontal side and
     * moved to a vertical and vica versa.
     */
    startIsSpecial: boolean | null;
    /**
     * Marks that the 3rd point backwards from the end should be used as the 2nd
     * point of the arrow in order to temporarily hide the last segment of the
     * arrow without losing the data from the points array. It allows creating
     * the expected arrow path when the arrow with fixed segments is bound on a
     * horizontal side and moved to a vertical and vica versa.
     */
    endIsSpecial: boolean | null;
  }
>;

export type DiagramFreeDrawElement = _DiagramElementBase &
  Readonly<{
    type: "freedraw";
    points: readonly LocalPoint[];
    pressures: readonly number[];
    simulatePressure: boolean;
    lastCommittedPoint: LocalPoint | null;
  }>;

export type FileId = string & { _brand: "FileId" };

export type DiagramElementType = DiagramElement["type"];

/**
 * Map of polaris-diagram elements.
 * Unspecified whether deleted or non-deleted.
 * Can be a subset of Scene elements.
 */
export type ElementsMap = Map<DiagramElement["id"], DiagramElement>;

/**
 * Map of non-deleted elements.
 * Can be a subset of Scene elements.
 */
export type NonDeletedElementsMap = Map<
  DiagramElement["id"],
  NonDeletedDiagramElement
> &
  MakeBrand<"NonDeletedElementsMap">;

/**
 * Map of all polaris-diagram Scene elements, including deleted.
 * Not a subset. Use this type when you need access to current Scene elements.
 */
export type SceneElementsMap = Map<
  DiagramElement["id"],
  Ordered<DiagramElement>
> &
  MakeBrand<"SceneElementsMap">;

/**
 * Map of all non-deleted Scene elements.
 * Not a subset. Use this type when you need access to current Scene elements.
 */
export type NonDeletedSceneElementsMap = Map<
  DiagramElement["id"],
  Ordered<NonDeletedDiagramElement>
> &
  MakeBrand<"NonDeletedSceneElementsMap">;

export type ElementsMapOrArray =
  | readonly DiagramElement[]
  | Readonly<ElementsMap>;
