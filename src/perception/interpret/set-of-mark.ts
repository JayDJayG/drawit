import type { InterpretRequest, InterpretStroke, InterpretText } from './types';

export type SetOfMarkPoint = {
  x: number;
  y: number;
};

export type SetOfMarkStroke = {
  id: string;
  points: SetOfMarkPoint[];
};

export type SetOfMarkText = {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SetOfMarkTag = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SetOfMarkLayout = {
  width: number;
  height: number;
  strokes: SetOfMarkStroke[];
  texts: SetOfMarkText[];
  marks: SetOfMarkTag[];
};

const PADDING = 24;
const MAX_SIDE = 1024;
const TAG_HEIGHT = 18;
const TAG_GAP = 4;
const INK_MARGIN = 2;
const TAG_OFFSETS = [TAG_GAP + INK_MARGIN, 12, 24, 40, 64, 96];
const GRID_CELL_SIZE = 32;

export const layoutSetOfMark = (
  request: Pick<InterpretRequest, 'strokes' | 'texts'>,
  maxSide = MAX_SIDE,
): SetOfMarkLayout => {
  const sourceBounds = getSourceBounds(request.strokes, request.texts);
  const longest = Math.max(sourceBounds.width, sourceBounds.height, 1);
  const boundedSide = Math.max(PADDING * 2 + 1, maxSide);
  const availableSide = boundedSide - PADDING * 2;
  const scale = Math.min(1, availableSide / longest);
  const width = Math.max(
    1,
    Math.min(boundedSide, Math.ceil(sourceBounds.width * scale + PADDING * 2)),
  );
  const height = Math.max(
    1,
    Math.min(boundedSide, Math.ceil(sourceBounds.height * scale + PADDING * 2)),
  );
  const transform = (point: SetOfMarkPoint): SetOfMarkPoint => ({
    x: PADDING + (point.x - sourceBounds.minX) * scale,
    y: PADDING + (point.y - sourceBounds.minY) * scale,
  });

  const strokes = request.strokes.map((stroke) => ({
    id: stroke.id,
    points: stroke.points.map(transform),
  }));
  const texts = request.texts.map((text) => {
    const topLeft = transform({ x: text.x, y: text.y });
    return {
      id: text.id,
      text: text.text,
      x: topLeft.x,
      y: topLeft.y,
      width: Math.max(1, text.width * scale),
      height: Math.max(1, text.height * scale),
    };
  });

  const textRects = texts.map((text) => rect(text.x, text.y, text.width, text.height));
  const strokeSegments = strokes.flatMap((stroke) => {
    const segments: Segment[] = [];
    for (let index = 1; index < stroke.points.length; index += 1) {
      const start = stroke.points[index - 1];
      const end = stroke.points[index];
      if (start && end) {
        segments.push({ start, end });
      }
    }
    return segments;
  });
  const segmentGrid = buildSegmentGrid(strokeSegments, width, height);
  const occupiedTags: Rect[] = [];
  const marks: SetOfMarkTag[] = [];
  const addMark = (
    id: string,
    anchor: SetOfMarkPoint,
    sourceBounds: Rect,
  ) => {
    const label = id;
    const tagWidth = Math.max(24, label.length * 7 + 8);
    const candidates = generateTagCandidates(
      anchor,
      sourceBounds,
      tagWidth,
      TAG_HEIGHT,
      width,
      height,
    );
    const freeCandidate = candidates.find((candidate) => !hasObstacleOverlap(
      candidate,
      strokeSegments,
      segmentGrid,
      textRects,
      occupiedTags,
    ));
    let chosen = freeCandidate;
    if (!chosen) {
      chosen = candidates[0]!;
      let bestScore = obstacleOverlapScore(
        chosen,
        strokeSegments,
        segmentGrid,
        textRects,
        occupiedTags,
      );
      for (let index = 1; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (!candidate) {
          continue;
        }
        const candidateScore = obstacleOverlapScore(
          candidate,
          strokeSegments,
          segmentGrid,
          textRects,
          occupiedTags,
        );
        if (candidateScore < bestScore) {
          chosen = candidate;
          bestScore = candidateScore;
        }
      }
    }
    const mark = {
      id,
      label,
      x: chosen.x,
      y: chosen.y,
      width: chosen.width,
      height: chosen.height,
    };
    marks.push(mark);
    occupiedTags.push(rect(mark.x, mark.y, mark.width, mark.height));
  };

  request.strokes.forEach((stroke, index) => {
    const rendered = strokes[index];
    const first = rendered?.points[0] ?? transform({
      x: sourceBounds.minX,
      y: sourceBounds.minY,
    });
    addMark(
      stroke.id,
      first,
      rendered ? boundsForPoints(rendered.points, first) : rect(first.x, first.y, 0, 0),
    );
  });
  request.texts.forEach((text, index) => {
    const rendered = texts[index];
    if (!rendered) {
      return;
    }
    addMark(text.id, {
      x: rendered.x + rendered.width,
      y: rendered.y,
    }, rect(rendered.x, rendered.y, rendered.width, rendered.height));
  });

  return { width, height, strokes, texts, marks };
};

const getSourceBounds = (
  strokes: readonly InterpretStroke[],
  texts: readonly InterpretText[],
) => {
  const xValues: number[] = [];
  const yValues: number[] = [];
  strokes.forEach((stroke) => {
    stroke.points.forEach((point) => {
      xValues.push(point.x);
      yValues.push(point.y);
    });
  });
  texts.forEach((text) => {
    xValues.push(text.x, text.x + Math.max(0, text.width));
    yValues.push(text.y, text.y + Math.max(0, text.height));
  });
  if (xValues.length === 0 || yValues.length === 0) {
    return { minX: 0, minY: 0, width: 1, height: 1 };
  }
  const minX = Math.min(...xValues);
  const minY = Math.min(...yValues);
  const maxX = Math.max(...xValues);
  const maxY = Math.max(...yValues);
  return {
    minX,
    minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
};

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Segment = {
  start: SetOfMarkPoint;
  end: SetOfMarkPoint;
};

type SegmentInterval = {
  lower: number;
  upper: number;
};

type SegmentGrid = {
  columns: number;
  rows: number;
  cells: number[][];
  seen: Uint32Array;
  queryStamp: number;
  querySegments: number[];
};

const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
});

const buildSegmentGrid = (
  segments: readonly Segment[],
  width: number,
  height: number,
): SegmentGrid => {
  const columns = Math.max(1, Math.ceil(width / GRID_CELL_SIZE));
  const rows = Math.max(1, Math.ceil(height / GRID_CELL_SIZE));
  const grid: SegmentGrid = {
    columns,
    rows,
    cells: Array.from({ length: columns * rows }, () => []),
    seen: new Uint32Array(segments.length),
    queryStamp: 0,
    querySegments: [],
  };
  segments.forEach((segment, index) => {
    const minX = Math.min(segment.start.x, segment.end.x) - INK_MARGIN;
    const maxX = Math.max(segment.start.x, segment.end.x) + INK_MARGIN;
    const minY = Math.min(segment.start.y, segment.end.y) - INK_MARGIN;
    const maxY = Math.max(segment.start.y, segment.end.y) + INK_MARGIN;
    const minCellX = Math.max(0, Math.floor(minX / GRID_CELL_SIZE));
    const maxCellX = Math.min(
      columns - 1,
      Math.floor(maxX / GRID_CELL_SIZE),
    );
    const minCellY = Math.max(0, Math.floor(minY / GRID_CELL_SIZE));
    const maxCellY = Math.min(
      rows - 1,
      Math.floor(maxY / GRID_CELL_SIZE),
    );
    if (minCellX > maxCellX || minCellY > maxCellY) {
      return;
    }
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        grid.cells[cellY * columns + cellX]?.push(index);
      }
    }
  });
  return grid;
};

const querySegmentGrid = (
  grid: SegmentGrid,
  candidate: Rect,
): readonly number[] => {
  grid.queryStamp += 1;
  if (grid.queryStamp === 0) {
    grid.seen.fill(0);
    grid.queryStamp = 1;
  }
  grid.querySegments.length = 0;
  const minCellX = Math.max(0, Math.floor(candidate.x / GRID_CELL_SIZE));
  const maxCellX = Math.min(
    grid.columns - 1,
    Math.floor((candidate.x + candidate.width) / GRID_CELL_SIZE),
  );
  const minCellY = Math.max(0, Math.floor(candidate.y / GRID_CELL_SIZE));
  const maxCellY = Math.min(
    grid.rows - 1,
    Math.floor((candidate.y + candidate.height) / GRID_CELL_SIZE),
  );
  for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      const cell = grid.cells[cellY * grid.columns + cellX];
      if (!cell) {
        continue;
      }
      for (const segmentIndex of cell) {
        if (grid.seen[segmentIndex] !== grid.queryStamp) {
          grid.seen[segmentIndex] = grid.queryStamp;
          grid.querySegments.push(segmentIndex);
        }
      }
    }
  }
  grid.querySegments.sort((one, two) => one - two);
  return grid.querySegments;
};

const clampRect = (
  value: Rect,
  width: number,
  height: number,
): Rect => ({
  ...value,
  x: Math.max(0, Math.min(value.x, Math.max(0, width - value.width))),
  y: Math.max(0, Math.min(value.y, Math.max(0, height - value.height))),
});

const overlaps = (one: Rect, two: Rect): boolean => {
  return one.x < two.x + two.width
    && one.x + one.width > two.x
    && one.y < two.y + two.height
    && one.y + one.height > two.y;
};

const boundsForPoints = (
  points: readonly SetOfMarkPoint[],
  fallback: SetOfMarkPoint,
): Rect => {
  if (points.length === 0) {
    return rect(fallback.x, fallback.y, 0, 0);
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return rect(
    minX,
    minY,
    Math.max(0, Math.max(...xs) - minX),
    Math.max(0, Math.max(...ys) - minY),
  );
};

const generateTagCandidates = (
  anchor: SetOfMarkPoint,
  sourceBounds: Rect,
  tagWidth: number,
  tagHeight: number,
  width: number,
  height: number,
): Rect[] => {
  const candidates: Rect[] = [];
  const seen = new Set<string>();
  const add = (value: Rect) => {
    const candidate = clampRect(value, width, height);
    const key = `${candidate.x}:${candidate.y}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(candidate);
    }
  };
  const centerX = sourceBounds.x + sourceBounds.width / 2;
  const centerY = sourceBounds.y + sourceBounds.height / 2;

  for (const offset of TAG_OFFSETS) {
    add(rect(anchor.x + offset, anchor.y - tagHeight - offset, tagWidth, tagHeight));
    add(rect(anchor.x + offset, anchor.y + offset, tagWidth, tagHeight));
    add(rect(anchor.x - tagWidth - offset, anchor.y - tagHeight - offset, tagWidth, tagHeight));
    add(rect(anchor.x - tagWidth - offset, anchor.y + offset, tagWidth, tagHeight));
    add(rect(anchor.x - tagWidth / 2, anchor.y - tagHeight - offset, tagWidth, tagHeight));
    add(rect(anchor.x - tagWidth / 2, anchor.y + offset, tagWidth, tagHeight));
    add(rect(anchor.x - tagWidth - offset, anchor.y - tagHeight / 2, tagWidth, tagHeight));
    add(rect(anchor.x + offset, anchor.y - tagHeight / 2, tagWidth, tagHeight));

    add(rect(centerX - tagWidth / 2, sourceBounds.y - tagHeight - offset, tagWidth, tagHeight));
    add(rect(centerX - tagWidth / 2, sourceBounds.y + sourceBounds.height + offset, tagWidth, tagHeight));
    add(rect(sourceBounds.x - tagWidth - offset, centerY - tagHeight / 2, tagWidth, tagHeight));
    add(rect(sourceBounds.x + sourceBounds.width + offset, centerY - tagHeight / 2, tagWidth, tagHeight));
    add(rect(sourceBounds.x - tagWidth - offset, sourceBounds.y - tagHeight - offset, tagWidth, tagHeight));
    add(rect(sourceBounds.x + sourceBounds.width + offset, sourceBounds.y - tagHeight - offset, tagWidth, tagHeight));
    add(rect(sourceBounds.x - tagWidth - offset, sourceBounds.y + sourceBounds.height + offset, tagWidth, tagHeight));
    add(rect(sourceBounds.x + sourceBounds.width + offset, sourceBounds.y + sourceBounds.height + offset, tagWidth, tagHeight));
  }
  return candidates;
};

const hasObstacleOverlap = (
  candidate: Rect,
  strokeSegments: readonly Segment[],
  segmentGrid: SegmentGrid,
  textRects: readonly Rect[],
  occupiedTags: readonly Rect[],
): boolean => {
  if (textRects.some((other) => overlaps(candidate, other))) {
    return true;
  }
  if (occupiedTags.some((other) => overlaps(candidate, other))) {
    return true;
  }
  const segmentIndices = querySegmentGrid(segmentGrid, candidate);
  for (const segmentIndex of segmentIndices) {
    const segment = strokeSegments[segmentIndex];
    if (segment && segmentIntersectsRect(
      segment.start,
      segment.end,
      candidate,
      INK_MARGIN,
    )) {
      return true;
    }
  }
  return false;
};

const obstacleOverlapScore = (
  candidate: Rect,
  strokeSegments: readonly Segment[],
  segmentGrid: SegmentGrid,
  textRects: readonly Rect[],
  occupiedTags: readonly Rect[],
): number => {
  const interval: SegmentInterval = { lower: 0, upper: 1 };
  let ink = 0;
  for (const segmentIndex of querySegmentGrid(segmentGrid, candidate)) {
    const segment = strokeSegments[segmentIndex];
    if (segment) {
      ink += segmentOverlapLength(
        segment.start,
        segment.end,
        candidate,
        INK_MARGIN,
        interval,
      );
    }
  }
  let area = 0;
  for (const textRect of textRects) {
    area += overlapArea(candidate, textRect);
  }
  for (const occupiedTag of occupiedTags) {
    area += overlapArea(candidate, occupiedTag);
  }
  return ink * 100 + area;
};

const overlapArea = (one: Rect, two: Rect): number => {
  const width = Math.max(
    0,
    Math.min(one.x + one.width, two.x + two.width) - Math.max(one.x, two.x),
  );
  const height = Math.max(
    0,
    Math.min(one.y + one.height, two.y + two.height) - Math.max(one.y, two.y),
  );
  return width * height;
};

const segmentIntersectsRect = (
  start: SetOfMarkPoint,
  end: SetOfMarkPoint,
  value: Rect,
  margin: number,
): boolean => {
  let lower = 0;
  let upper = 1;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const minX = value.x - margin;
  const minY = value.y - margin;
  const maxX = value.x + value.width + margin;
  const maxY = value.y + value.height + margin;

  let p = -dx;
  let q = start.x - minX;
  if (Math.abs(p) < Number.EPSILON) {
    if (q < 0) {
      return false;
    }
  } else {
    const ratio = q / p;
    if (p < 0) {
      if (ratio > upper) {
        return false;
      }
      lower = Math.max(lower, ratio);
    } else {
      if (ratio < lower) {
        return false;
      }
      upper = Math.min(upper, ratio);
    }
  }

  p = dx;
  q = maxX - start.x;
  if (Math.abs(p) < Number.EPSILON) {
    if (q < 0) {
      return false;
    }
  } else {
    const ratio = q / p;
    if (p < 0) {
      if (ratio > upper) {
        return false;
      }
      lower = Math.max(lower, ratio);
    } else {
      if (ratio < lower) {
        return false;
      }
      upper = Math.min(upper, ratio);
    }
  }

  p = -dy;
  q = start.y - minY;
  if (Math.abs(p) < Number.EPSILON) {
    if (q < 0) {
      return false;
    }
  } else {
    const ratio = q / p;
    if (p < 0) {
      if (ratio > upper) {
        return false;
      }
      lower = Math.max(lower, ratio);
    } else {
      if (ratio < lower) {
        return false;
      }
      upper = Math.min(upper, ratio);
    }
  }

  p = dy;
  q = maxY - start.y;
  if (Math.abs(p) < Number.EPSILON) {
    if (q < 0) {
      return false;
    }
  } else {
    const ratio = q / p;
    if (p < 0) {
      if (ratio > upper) {
        return false;
      }
      lower = Math.max(lower, ratio);
    } else {
      if (ratio < lower) {
        return false;
      }
      upper = Math.min(upper, ratio);
    }
  }
  return true;
};

const segmentOverlapLength = (
  start: SetOfMarkPoint,
  end: SetOfMarkPoint,
  value: Rect,
  margin: number,
  interval: SegmentInterval,
): number => {
  if (!segmentRectInterval(start, end, value, margin, interval)) {
    return 0;
  }
  return Math.hypot(end.x - start.x, end.y - start.y)
    * Math.max(0, interval.upper - interval.lower);
};

const segmentRectInterval = (
  start: SetOfMarkPoint,
  end: SetOfMarkPoint,
  value: Rect,
  margin: number,
  interval: SegmentInterval,
): boolean => {
  let lower = 0;
  let upper = 1;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const minX = value.x - margin;
  const minY = value.y - margin;
  const maxX = value.x + value.width + margin;
  const maxY = value.y + value.height + margin;

  let p = -dx;
  let q = start.x - minX;
  if (Math.abs(p) < Number.EPSILON) {
    if (q < 0) {
      return false;
    }
  } else {
    const ratio = q / p;
    if (p < 0) {
      if (ratio > upper) {
        return false;
      }
      lower = Math.max(lower, ratio);
    } else {
      if (ratio < lower) {
        return false;
      }
      upper = Math.min(upper, ratio);
    }
  }

  p = dx;
  q = maxX - start.x;
  if (Math.abs(p) < Number.EPSILON) {
    if (q < 0) {
      return false;
    }
  } else {
    const ratio = q / p;
    if (p < 0) {
      if (ratio > upper) {
        return false;
      }
      lower = Math.max(lower, ratio);
    } else {
      if (ratio < lower) {
        return false;
      }
      upper = Math.min(upper, ratio);
    }
  }

  p = -dy;
  q = start.y - minY;
  if (Math.abs(p) < Number.EPSILON) {
    if (q < 0) {
      return false;
    }
  } else {
    const ratio = q / p;
    if (p < 0) {
      if (ratio > upper) {
        return false;
      }
      lower = Math.max(lower, ratio);
    } else {
      if (ratio < lower) {
        return false;
      }
      upper = Math.min(upper, ratio);
    }
  }

  p = dy;
  q = maxY - start.y;
  if (Math.abs(p) < Number.EPSILON) {
    if (q < 0) {
      return false;
    }
  } else {
    const ratio = q / p;
    if (p < 0) {
      if (ratio > upper) {
        return false;
      }
      lower = Math.max(lower, ratio);
    } else {
      if (ratio < lower) {
        return false;
      }
      upper = Math.min(upper, ratio);
    }
  }
  interval.lower = lower;
  interval.upper = upper;
  return true;
};
