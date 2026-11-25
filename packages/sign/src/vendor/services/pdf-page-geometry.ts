// Copied from SignuDoc (MIT, Copyright (c) 2026 Nyllon Software); see ../LICENSE-SignuDoc.
import {
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
  type PDFPage,
} from "pdf-lib";

// Where a page's content is, as a reader shows it.
//
// Fields are placed on the page the browser shows: the part inside the
// CropBox, turned by the page's /Rotate. A scanned landscape page is often a
// portrait page with /Rotate 90, and a page's box need not start at 0,0. So
// a field's place on the shown page is not its place in the page's own
// coordinates (user space), which is where content is drawn.
//
// Everything here is read from the PDF page itself, never from the sizes
// stored with an envelope, so it is right for documents imported before the
// stored sizes were those of the shown page.

type Box = {
  height: number;
  width: number;
  x: number;
  y: number;
};

/** a b c d e f, as the `cm` operator takes them. */
type Matrix = [number, number, number, number, number, number];

export type DisplayedPageGeometry = {
  /** The height of the page as shown, in points. */
  heightPt: number;
  /**
   * Maps a point on the shown page (origin at its bottom left, y up, in
   * points) to user space. Null when the two are the same, which is every
   * page with no rotation and a box that starts at 0,0.
   */
  toUserSpace: Matrix | null;
  /** The width of the page as shown, in points. */
  widthPt: number;
};

/** A box with a positive size, whichever corners the PDF listed. */
function normalizeBox(box: Box): Box {
  return {
    height: Math.abs(box.height),
    width: Math.abs(box.width),
    x: Math.min(box.x, box.x + box.width),
    y: Math.min(box.y, box.y + box.height),
  };
}

/**
 * The part of the page a reader shows: the CropBox where it lies inside the
 * MediaBox, or the MediaBox when there is no such part. pdf.js does the same.
 */
function getVisibleBox(page: PDFPage): Box {
  const mediaBox = normalizeBox(page.getMediaBox());
  const cropBox = normalizeBox(page.getCropBox());
  const left = Math.max(mediaBox.x, cropBox.x);
  const bottom = Math.max(mediaBox.y, cropBox.y);
  const right = Math.min(
    mediaBox.x + mediaBox.width,
    cropBox.x + cropBox.width,
  );
  const top = Math.min(
    mediaBox.y + mediaBox.height,
    cropBox.y + cropBox.height,
  );

  if (right - left <= 0 || top - bottom <= 0) {
    return mediaBox;
  }

  return { height: top - bottom, width: right - left, x: left, y: bottom };
}

/** The page's rotation as 0, 90, 180 or 270. Any other angle counts as 0. */
function getQuarterTurns(page: PDFPage): 0 | 90 | 180 | 270 {
  const angle = page.getRotation().angle;

  if (!Number.isFinite(angle) || angle % 90 !== 0) {
    return 0;
  }

  return (((angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}

export function getDisplayedPageGeometry(page: PDFPage): DisplayedPageGeometry {
  const box = getVisibleBox(page);
  const rotation = getQuarterTurns(page);

  switch (rotation) {
    case 90:
      // Shown turned a quarter clockwise: the box's left edge is on top.
      return {
        heightPt: box.width,
        toUserSpace: [0, 1, -1, 0, box.x + box.width, box.y],
        widthPt: box.height,
      };
    case 180:
      return {
        heightPt: box.height,
        toUserSpace: [-1, 0, 0, -1, box.x + box.width, box.y + box.height],
        widthPt: box.width,
      };
    case 270:
      // Shown turned a quarter anticlockwise: the box's right edge is on top.
      return {
        heightPt: box.width,
        toUserSpace: [0, -1, 1, 0, box.x, box.y + box.height],
        widthPt: box.height,
      };
    default:
      return {
        heightPt: box.height,
        toUserSpace:
          box.x === 0 && box.y === 0 ? null : [1, 0, 0, 1, box.x, box.y],
        widthPt: box.width,
      };
  }
}

/**
 * Runs `draw` with the page's coordinates set to those of the shown page, so
 * that what it draws lands where it was placed and reads upright. A page
 * that needs no change gets no extra operators.
 */
export async function drawOnDisplayedPage(
  page: PDFPage,
  geometry: DisplayedPageGeometry,
  draw: () => Promise<void> | void,
): Promise<void> {
  if (!geometry.toUserSpace) {
    await draw();

    return;
  }

  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...geometry.toUserSpace),
  );

  try {
    await draw();
  } finally {
    page.pushOperators(popGraphicsState());
  }
}

/**
 * The rectangle in user space that covers a rectangle given on the shown
 * page (bottom-left origin, points). This is what an annotation's /Rect and
 * a form's /BBox take.
 */
export function displayedRectToUserSpaceBox(
  rect: { heightPt: number; widthPt: number; xPt: number; yPt: number },
  geometry: DisplayedPageGeometry,
): { bottom: number; left: number; right: number; top: number } {
  if (!geometry.toUserSpace) {
    return {
      bottom: rect.yPt,
      left: rect.xPt,
      right: rect.xPt + rect.widthPt,
      top: rect.yPt + rect.heightPt,
    };
  }

  const [a, b, c, d, e, f] = geometry.toUserSpace;
  const corners = [
    [rect.xPt, rect.yPt],
    [rect.xPt + rect.widthPt, rect.yPt + rect.heightPt],
  ].map(([x, y]) => [a * x! + c * y! + e, b * x! + d * y! + f]);
  const xs = corners.map((corner) => corner[0]!);
  const ys = corners.map((corner) => corner[1]!);

  return {
    bottom: Math.min(...ys),
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.max(...ys),
  };
}

/** A page's size as stored with its envelope, which the field overlay uses. */
export type StoredPageSize = {
  heightPt: number;
  pageNumber: number;
  widthPt: number;
};

/**
 * A field's place on the shown page, from its place on the stored page.
 *
 * Fields are placed on a box laid out to the page's stored size, with the
 * shown page drawn in it as large as fits, centred. Envelopes made before
 * page sizes were read as shown stored the raw MediaBox, so on a rotated or
 * cropped page the box has another shape than the page in it, and the page
 * sits inside it with a margin. This turns the field's place on that box
 * into its place on the page, so it is stamped where the sender saw it.
 *
 * When the box has the page's shape, which is every page imported since,
 * the field is returned as it is.
 */
export function fieldOnDisplayedPage<
  Rect extends { height: number; width: number; x: number; y: number },
>(
  rect: Rect,
  stored: Pick<StoredPageSize, "heightPt" | "widthPt"> | undefined,
  geometry: Pick<DisplayedPageGeometry, "heightPt" | "widthPt">,
): Rect {
  if (
    !stored ||
    !(stored.widthPt > 0) ||
    !(stored.heightPt > 0) ||
    !(geometry.widthPt > 0) ||
    !(geometry.heightPt > 0)
  ) {
    return rect;
  }

  const boxAspect = stored.widthPt / stored.heightPt;
  const pageAspect = geometry.widthPt / geometry.heightPt;

  if (Math.abs(boxAspect - pageAspect) <= 1e-6 * pageAspect) {
    return rect;
  }

  // Measured in units of the box: the page drawn in it, and its margins.
  const scale = Math.min(
    stored.widthPt / geometry.widthPt,
    stored.heightPt / geometry.heightPt,
  );
  const drawnWidth = (scale * geometry.widthPt) / stored.widthPt;
  const drawnHeight = (scale * geometry.heightPt) / stored.heightPt;
  const left = (1 - drawnWidth) / 2;
  const top = (1 - drawnHeight) / 2;

  return {
    ...rect,
    height: rect.height / drawnHeight,
    width: rect.width / drawnWidth,
    x: (rect.x - left) / drawnWidth,
    y: (rect.y - top) / drawnHeight,
  };
}
