export type Point = {
  x: number;
  y: number;
};

export type Stroke = {
  id: number;
  points: Point[];
};

export type ImprovementMode = 'unchanged' | 'smoothed' | 'straightened' | 'circled';

export type ImprovementResult = {
  points: Point[];
  mode: ImprovementMode;
  removedPoints: number;
};

export type GroupImprovementMode = 'unchanged' | 'rectangle';

export type GroupImprovementResult = {
  replacements: Stroke[];
  mode: GroupImprovementMode;
  removedPoints: number;
};

export class DrawingImprovementEngine {
  private readonly minimumPointDistance = 2.5;

  improve(stroke: readonly Point[]): ImprovementResult {
    const original = stroke.map((point) => ({ ...point }));

    if (original.length < 3) {
      return {
        points: original,
        mode: 'unchanged',
        removedPoints: 0,
      };
    }

    const simplified = this.removeNearPoints(original);
    const removedPoints = original.length - simplified.length;

    if (simplified.length < 3) {
      return {
        points: simplified,
        mode: removedPoints > 0 ? 'smoothed' : 'unchanged',
        removedPoints,
      };
    }

    if (this.isCircleCandidate(simplified)) {
      const circle = this.fitCircle(simplified);

      return {
        points: circle,
        mode: 'circled',
        removedPoints,
      };
    }

    if (this.isMostlyStraight(simplified)) {
      const straightened = this.straighten(simplified);

      return {
        points: straightened,
        mode: this.isSameStroke(original, straightened) ? 'unchanged' : 'straightened',
        removedPoints,
      };
    }

    const smoothed = this.smooth(simplified);

    return {
      points: smoothed,
      mode: this.isSameStroke(original, smoothed) ? 'unchanged' : 'smoothed',
      removedPoints,
    };
  }

  improveGroup(strokes: readonly Stroke[]): GroupImprovementResult {
    const original = strokes.map((stroke) => ({
      id: stroke.id,
      points: stroke.points.map((point) => ({ ...point })),
    }));

    if (!this.isRectangleCandidate(original)) {
      return {
        replacements: original,
        mode: 'unchanged',
        removedPoints: 0,
      };
    }

    const bounds = this.getBounds(original.flatMap((stroke) => stroke.points));
    const horizontal = original
      .filter((stroke) => this.isHorizontal(stroke))
      .sort((first, second) => this.getCenter(first.points).y - this.getCenter(second.points).y);
    const vertical = original
      .filter((stroke) => !this.isHorizontal(stroke))
      .sort((first, second) => this.getCenter(first.points).x - this.getCenter(second.points).x);
    const top = horizontal[0];
    const bottom = horizontal[1];
    const left = vertical[0];
    const right = vertical[1];

    const replacements: Stroke[] = [
      {
        id: top.id,
        points: [
          { x: bounds.minX, y: bounds.minY },
          { x: bounds.maxX, y: bounds.minY },
        ],
      },
      {
        id: bottom.id,
        points: [
          { x: bounds.minX, y: bounds.maxY },
          { x: bounds.maxX, y: bounds.maxY },
        ],
      },
      {
        id: left.id,
        points: [
          { x: bounds.minX, y: bounds.minY },
          { x: bounds.minX, y: bounds.maxY },
        ],
      },
      {
        id: right.id,
        points: [
          { x: bounds.maxX, y: bounds.minY },
          { x: bounds.maxX, y: bounds.maxY },
        ],
      },
    ];
    const originalPointCount = original.reduce((total, stroke) => {
      return total + stroke.points.length;
    }, 0);

    return {
      replacements,
      mode: 'rectangle',
      removedPoints: Math.max(0, originalPointCount - replacements.length * 2),
    };
  }

  private removeNearPoints(points: Point[]): Point[] {
    const simplified = [points[0]];

    for (let index = 1; index < points.length - 1; index += 1) {
      const point = points[index];
      const previous = simplified[simplified.length - 1];

      if (this.distance(previous, point) >= this.minimumPointDistance) {
        simplified.push(point);
      }
    }

    simplified.push(points[points.length - 1]);
    return simplified;
  }

  private isMostlyStraight(points: Point[]): boolean {
    const start = points[0];
    const end = points[points.length - 1];
    const length = this.distance(start, end);

    if (length < 30) {
      return false;
    }

    const maximumDeviation = points.reduce((maximum, point) => {
      return Math.max(maximum, this.distanceFromLine(point, start, end));
    }, 0);

    return maximumDeviation <= Math.max(4, length * 0.08);
  }

  private isRectangleCandidate(strokes: Stroke[]): boolean {
    if (strokes.length !== 4 || strokes.some((stroke) => stroke.points.length < 2)) {
      return false;
    }

    if (strokes.some((stroke) => !this.isMostlyStraight(stroke.points))) {
      return false;
    }

    const bounds = this.getBounds(strokes.flatMap((stroke) => stroke.points));
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;

    if (width < 30 || height < 30) {
      return false;
    }

    const horizontal = strokes.filter((stroke) => this.isHorizontal(stroke));
    const vertical = strokes.filter((stroke) => !this.isHorizontal(stroke));

    if (horizontal.length !== 2 || vertical.length !== 2) {
      return false;
    }

    const tolerance = Math.max(12, Math.min(width, height) * 0.2);
    const horizontalCenters = horizontal.map((stroke) => this.getCenter(stroke.points).y);
    const verticalCenters = vertical.map((stroke) => this.getCenter(stroke.points).x);

    if (
      Math.abs(horizontalCenters[0] - horizontalCenters[1]) < height * 0.4
      || Math.abs(verticalCenters[0] - verticalCenters[1]) < width * 0.4
    ) {
      return false;
    }

    const horizontalSidesFit = horizontal.every((stroke) => {
      const strokeBounds = this.getBounds(stroke.points);
      return (
        strokeBounds.maxX - strokeBounds.minX >= width * 0.5
        && Math.min(
          Math.abs(strokeBounds.minX - bounds.minX),
          Math.abs(strokeBounds.maxX - bounds.maxX),
        ) <= tolerance
      );
    });
    const verticalSidesFit = vertical.every((stroke) => {
      const strokeBounds = this.getBounds(stroke.points);
      return (
        strokeBounds.maxY - strokeBounds.minY >= height * 0.5
        && Math.min(
          Math.abs(strokeBounds.minY - bounds.minY),
          Math.abs(strokeBounds.maxY - bounds.maxY),
        ) <= tolerance
      );
    });

    return horizontalSidesFit && verticalSidesFit;
  }

  private isHorizontal(stroke: Stroke): boolean {
    const first = stroke.points[0];
    const last = stroke.points[stroke.points.length - 1];

    return Math.abs(last.x - first.x) >= Math.abs(last.y - first.y);
  }

  private getCenter(points: Point[]): Point {
    const bounds = this.getBounds(points);

    return {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };
  }

  private isCircleCandidate(points: Point[]): boolean {
    if (points.length < 8) {
      return false;
    }

    const pathLength = this.pathLength(points);
    const startEndDistance = this.distance(points[0], points[points.length - 1]);

    if (pathLength < 60 || startEndDistance > Math.max(20, pathLength * 0.2)) {
      return false;
    }

    const bounds = this.getBounds(points);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const aspectRatio = Math.min(width, height) / Math.max(width, height);

    if (Math.min(width, height) < 25 || aspectRatio < 0.72) {
      return false;
    }

    const center = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };
    const radii = points.map((point) => this.distance(point, center));
    const averageRadius = radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
    const radialError = Math.sqrt(
      radii.reduce((sum, radius) => sum + ((radius - averageRadius) ** 2), 0) / radii.length,
    ) / averageRadius;

    return averageRadius > 12 && radialError < 0.18;
  }

  private fitCircle(points: Point[]): Point[] {
    const bounds = this.getBounds(points);
    const center = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };
    const radius = points.reduce((sum, point) => {
      return sum + this.distance(point, center);
    }, 0) / points.length;
    const startAngle = Math.atan2(points[0].y - center.y, points[0].x - center.x);
    const direction = this.signedArea(points) >= 0 ? 1 : -1;
    const segmentCount = Math.max(32, Math.min(96, points.length * 2));
    const circle: Point[] = [];

    for (let index = 0; index <= segmentCount; index += 1) {
      const angle = startAngle + (direction * Math.PI * 2 * index) / segmentCount;
      circle.push({
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
      });
    }

    return circle;
  }

  private getBounds(points: Point[]) {
    return points.reduce((bounds, point) => {
      return {
        minX: Math.min(bounds.minX, point.x),
        maxX: Math.max(bounds.maxX, point.x),
        minY: Math.min(bounds.minY, point.y),
        maxY: Math.max(bounds.maxY, point.y),
      };
    }, {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    });
  }

  private signedArea(points: Point[]): number {
    let area = 0;

    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      area += (previous.x * current.y) - (current.x * previous.y);
    }

    return area;
  }

  private straighten(points: Point[]): Point[] {
    const start = points[0];
    const end = points[points.length - 1];
    const direction = {
      x: end.x - start.x,
      y: end.y - start.y,
    };
    const totalDistance = this.pathLength(points);

    if (totalDistance === 0) {
      return points.map((point) => ({ ...point }));
    }

    let traveledDistance = 0;

    return points.map((point, index) => {
      if (index === 0 || index === points.length - 1) {
        return { ...point };
      }

      traveledDistance += this.distance(points[index - 1], point);
      const progress = traveledDistance / totalDistance;

      return {
        x: start.x + direction.x * progress,
        y: start.y + direction.y * progress,
      };
    });
  }

  private smooth(points: Point[]): Point[] {
    const corners = this.findCorners(points);
    let smoothed = points.map((point) => ({ ...point }));

    for (let pass = 0; pass < 2; pass += 1) {
      smoothed = smoothed.map((point, index) => {
        if (corners.has(index) || index === 0 || index === smoothed.length - 1) {
          return { ...point };
        }

        const previousPrevious = smoothed[Math.max(0, index - 2)];
        const previous = smoothed[index - 1];
        const next = smoothed[index + 1];
        const nextNext = smoothed[Math.min(smoothed.length - 1, index + 2)];

        return {
          x: (
            previousPrevious.x
            + (previous.x * 2)
            + (point.x * 4)
            + (next.x * 2)
            + nextNext.x
          ) / 10,
          y: (
            previousPrevious.y
            + (previous.y * 2)
            + (point.y * 4)
            + (next.y * 2)
            + nextNext.y
          ) / 10,
        };
      });
    }

    return smoothed;
  }

  private findCorners(points: Point[]): Set<number> {
    const corners = new Set<number>([0, points.length - 1]);

    for (let index = 1; index < points.length - 1; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const next = points[index + 1];
      const incoming = this.distance(previous, current);
      const outgoing = this.distance(current, next);

      if (incoming < 4 || outgoing < 4) {
        continue;
      }

      const angle = this.angleAtPoint(previous, current, next);
      const deviation = this.distanceFromLine(current, previous, next);

      if (angle < Math.PI * 0.7 && deviation > 1.5) {
        corners.add(index);
      }
    }

    return corners;
  }

  private angleAtPoint(previous: Point, current: Point, next: Point): number {
    const first = {
      x: previous.x - current.x,
      y: previous.y - current.y,
    };
    const second = {
      x: next.x - current.x,
      y: next.y - current.y,
    };
    const denominator = Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y);

    if (denominator === 0) {
      return Math.PI;
    }

    const cosine = (first.x * second.x + first.y * second.y) / denominator;
    return Math.acos(Math.max(-1, Math.min(1, cosine)));
  }

  private distanceFromLine(point: Point, start: Point, end: Point): number {
    const lineLength = this.distance(start, end);

    if (lineLength === 0) {
      return this.distance(point, start);
    }

    return Math.abs(
      ((end.x - start.x) * (start.y - point.y))
      - ((start.x - point.x) * (end.y - start.y)),
    ) / lineLength;
  }

  private pathLength(points: Point[]): number {
    let length = 0;

    for (let index = 1; index < points.length; index += 1) {
      length += this.distance(points[index - 1], points[index]);
    }

    return length;
  }

  private distance(first: Point, second: Point): number {
    return Math.hypot(first.x - second.x, first.y - second.y);
  }

  private isSameStroke(first: Point[], second: Point[]): boolean {
    if (first.length !== second.length) {
      return false;
    }

    return first.every((point, index) => {
      return this.distance(point, second[index]) < 0.1;
    });
  }
}
