/**
 * Timeline math shared by the merge engine and the Play all preview, so the
 * crossfades you hear before merging match the ones in the exported file.
 */

/** Where each clip lands when joins overlap, plus the fade at each edge. */
export interface Timeline {
  starts: number[];
  fadesIn: number[];
  fadesOut: number[];
  total: number;
}

/**
 * Overlaps adjacent clips by `seconds`, clamped so a short clip never fades
 * more than its own length (including a fade on its other edge).
 */
export function buildTimeline(spans: number[], seconds: number): Timeline {
  const count = spans.length;
  const fadesIn = new Array<number>(count).fill(0);
  const fadesOut = new Array<number>(count).fill(0);

  for (let i = 1; i < count; i++) {
    const available = Math.min(spans[i - 1]! - fadesOut[i - 1]!, spans[i]!);
    const fade = Math.min(seconds, Math.max(0, available));
    fadesOut[i - 1] = fade;
    fadesIn[i] = fade;
  }

  const starts = new Array<number>(count).fill(0);
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    if (i > 0) cursor -= fadesOut[i - 1]!;
    starts[i] = cursor;
    cursor += spans[i]!;
  }

  return { starts, fadesIn, fadesOut, total: Math.max(0, cursor) };
}
