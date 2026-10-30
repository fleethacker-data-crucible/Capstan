import { describe, expect, test } from 'bun:test';
import {
  addAnnotation,
  applyStylePreset,
  duplicateAnnotation,
  moveAnnotation,
  removeAnnotation,
  reorderAnnotation,
  setAnnotationTiming,
  updateAnnotation,
} from '../../src/engine/annotationOps';
import {
  ANNOTATION_KINDS,
  MAX_ANNOTATIONS,
  MAX_ANNOTATION_TEXT,
  STYLE_PRESETS,
  activeAnnotationsAt,
  defaultAnnotation,
  drawAnnotations,
  fromLocal,
  hitTestAnnotation,
  lineCanvas,
  lineEndsPatch,
  outlineLength,
  parseAnnotations,
  rescaleAnnotations,
  resolveAnnotation,
  sketchProgress,
  tailCanvas,
  toLocal,
} from '../../src/engine/annotations';
import { resizeCanvas } from '../../src/engine/ops';
import { createProject, parseProject } from '../../src/engine/project';

const canvas = { width: 1920, height: 1080 };

describe('parseAnnotations', () => {
  test('drops junk, unknown kinds and non-objects', () => {
    expect(parseAnnotations(null, canvas)).toEqual([]);
    expect(parseAnnotations('x', canvas)).toEqual([]);
    expect(parseAnnotations([1, null, 'a', { kind: 'laser' }, { kind: 5 }, []], canvas)).toEqual([]);
  });

  test('clamps numbers and falls back to defaults for bad values', () => {
    const [a] = parseAnnotations(
      [{ id: 'a', kind: 'rect', start: -5, duration: 1e9, x: 1e12, y: NaN, width: -3, height: 'tall', rotation: Infinity, opacity: 9, style: { strokeWidth: 999, size: -1, fill: 'javascript:1', color: 'red', font: 'comic', align: 'sideways' } }],
      canvas,
    );
    expect(a.start).toBe(0);
    expect(a.duration).toBe(3600);
    expect(a.x).toBe(canvas.width * 2);
    expect(Number.isFinite(a.y)).toBe(true);
    expect(a.width).toBeGreaterThanOrEqual(8);
    expect(a.height).toBeGreaterThanOrEqual(8);
    expect(a.rotation).toBe(0);
    expect(a.opacity).toBe(1);
    expect(a.style.strokeWidth).toBe(40);
    expect(a.style.size).toBe(6);
    expect(a.style.fill).toBe('');
    expect(a.style.color).toBe('#ffffff');
    expect(a.style.font).toBe('sans');
    expect(a.style.align).toBe('center');
  });

  test('caps the text, ignores text on shapes, and makes ids unique', () => {
    const list = parseAnnotations(
      [
        { id: 'same', kind: 'text', text: 'x'.repeat(MAX_ANNOTATION_TEXT + 500) },
        { id: 'same', kind: 'rect', text: 'not for shapes' },
        { kind: 'callout', text: 'hi' },
      ],
      canvas,
    );
    expect(list.length).toBe(3);
    expect(list[0].text.length).toBe(MAX_ANNOTATION_TEXT);
    expect(list[1].text).toBe('');
    expect(new Set(list.map((a) => a.id)).size).toBe(3);
  });

  test('caps the number of annotations', () => {
    const many = Array.from({ length: MAX_ANNOTATIONS + 20 }, (_, i) => ({ id: `n${i}`, kind: 'line' }));
    expect(parseAnnotations(many, canvas).length).toBe(MAX_ANNOTATIONS);
  });

  test('keeps valid keyframes, drops bad ones, and round-trips a created annotation', () => {
    const a = defaultAnnotation('callout', canvas, 2, 'c1');
    a.keys = { x: [{ t: 0, v: 100, ease: 'linear' }, { t: 1, v: 400, ease: 'out' }], opacity: [{ t: 'bad' as unknown as number, v: 1, ease: 'linear' }] };
    const back = parseAnnotations(JSON.parse(JSON.stringify([a])), canvas)[0];
    expect(back.keys?.x?.length).toBe(2);
    expect(back.keys?.opacity).toBeUndefined();
    expect({ ...back, keys: undefined }).toEqual({ ...a, keys: undefined });
  });

  test('a project file without annotations still loads, and one with them keeps them', () => {
    const p = createProject();
    const { project } = addAnnotation(p, 'text', 1);
    const again = parseProject(JSON.parse(JSON.stringify(project)));
    expect(again.annotations.length).toBe(1);
    expect(again.annotations[0].text).toBe('Your text');
  });
});

describe('every kind gets sane defaults', () => {
  for (const kind of ANNOTATION_KINDS) {
    test(kind, () => {
      const a = defaultAnnotation(kind, canvas, 1.5, 'x');
      expect(a.start).toBe(1.5);
      expect(a.width).toBeGreaterThan(0);
      expect(a.height).toBeGreaterThan(0);
      expect(a.x + a.width / 2).toBeCloseTo(canvas.width / 2, 0);
      // The parser accepts what the defaults produce unchanged.
      expect(parseAnnotations([a], canvas)[0]).toEqual(a);
    });
  }
});

describe('ops', () => {
  const p0 = createProject();

  test('add puts new items on top and selects nothing by itself', () => {
    const a = addAnnotation(p0, 'rect', 2);
    const b = addAnnotation(a.project, 'arrow', 3);
    expect(b.project.annotations.map((x) => x.kind)).toEqual(['rect', 'arrow']);
    expect(b.project.annotations[1].start).toBe(3);
    expect(b.project.updatedAt).toBeGreaterThanOrEqual(p0.updatedAt);
    expect(p0.annotations.length).toBe(0);
  });

  test('update validates and keeps style fields it was not given', () => {
    const { project, id } = addAnnotation(p0, 'text', 0);
    const next = updateAnnotation(project, id, { text: 'Hello', style: { size: 9999, bold: true } });
    const a = next.annotations[0];
    expect(a.text).toBe('Hello');
    expect(a.style.size).toBe(400);
    expect(a.style.bold).toBe(true);
    expect(a.style.color).toBe('#ffffff');
    expect(updateAnnotation(project, 'missing', { text: 'x' })).toBe(project);
  });

  test('update keeps keyframes and behavior it was not told about', () => {
    const { project, id } = addAnnotation(p0, 'rect', 0);
    const keyed = updateAnnotation(project, id, { keys: { opacity: [{ t: 0, v: 0, ease: 'linear' }, { t: 1, v: 1, ease: 'linear' }] } });
    const moved = updateAnnotation(keyed, id, { x: 50 });
    expect(moved.annotations[0].keys?.opacity?.length).toBe(2);
    const withBehavior = { ...moved, annotations: moved.annotations.map((a) => ({ ...a, behavior: { enter: { type: 'fade', duration: 0.5 } } })) };
    expect(updateAnnotation(withBehavior, id, { x: 60 }).annotations[0].behavior?.enter?.type).toBe('fade');
  });

  test('remove, duplicate and reorder', () => {
    let p = addAnnotation(p0, 'rect', 0).project;
    p = addAnnotation(p, 'ellipse', 0).project;
    p = addAnnotation(p, 'line', 0).project;
    const [r, e, l] = p.annotations.map((a) => a.id);
    expect(reorderAnnotation(p, r, 'front').annotations.map((a) => a.id)).toEqual([e, l, r]);
    expect(reorderAnnotation(p, l, 'back').annotations.map((a) => a.id)).toEqual([l, r, e]);
    expect(reorderAnnotation(p, e, 'forward').annotations.map((a) => a.id)).toEqual([r, l, e]);
    expect(reorderAnnotation(p, e, 'backward').annotations.map((a) => a.id)).toEqual([e, r, l]);
    expect(reorderAnnotation(p, l, 'front')).toBe(p);
    const d = duplicateAnnotation(p, e);
    expect(d.project.annotations.length).toBe(4);
    expect(d.project.annotations[2].id).toBe(d.id);
    expect(d.id).not.toBe(e);
    expect(d.project.annotations[2].x).toBeGreaterThan(p.annotations[1].x);
    const gone = removeAnnotation(d.project, r);
    expect(gone.annotations.length).toBe(3);
    expect(removeAnnotation(gone, r)).toBe(gone);
  });

  test('moving takes x / y keyframes along', () => {
    const { project, id } = addAnnotation(p0, 'rect', 0);
    const a0 = project.annotations[0];
    const keyed = updateAnnotation(project, id, { keys: { x: [{ t: 0, v: 100, ease: 'linear' }], opacity: [{ t: 0, v: 1, ease: 'linear' }] } });
    const moved = moveAnnotation(keyed, id, 30, -10).annotations[0];
    expect(moved.x).toBe(a0.x + 30);
    expect(moved.y).toBe(a0.y - 10);
    expect(moved.keys?.x?.[0].v).toBe(130);
    expect(moved.keys?.y).toBeUndefined();
    expect(moved.keys?.opacity?.length).toBe(1);
  });

  test('moving in time leaves keyframes, trimming the start shifts them', () => {
    const { project, id } = addAnnotation(p0, 'rect', 2);
    const keyed = updateAnnotation(project, id, { duration: 4, keys: { opacity: [{ t: 1, v: 0.5, ease: 'linear' }] } });
    const moved = setAnnotationTiming(keyed, id, { start: 5 }).annotations[0];
    expect(moved.start).toBe(5);
    expect(moved.keys?.opacity?.[0].t).toBe(1);
    const trimmed = setAnnotationTiming(keyed, id, { start: 3, duration: 3 }).annotations[0];
    expect(trimmed.start).toBe(3);
    expect(trimmed.duration).toBe(3);
    expect(trimmed.keys?.opacity?.[0].t).toBe(0); // 1 - 1, clamped at the item start
    expect(setAnnotationTiming(keyed, id, { duration: 0 }).annotations[0].duration).toBeGreaterThan(0);
  });

  test('presets change the style only', () => {
    const { project, id } = addAnnotation(p0, 'text', 0);
    const preset = STYLE_PRESETS.find((s) => s.id === 'code')!;
    const a = applyStylePreset(project, id, preset).annotations[0];
    expect(a.style.font).toBe('mono');
    expect(a.text).toBe('Your text');
    expect(a.width).toBe(project.annotations[0].width);
  });

  test('every preset produces a valid style', () => {
    for (const preset of STYLE_PRESETS) {
      const { project, id } = addAnnotation(p0, preset.kinds[0], 0);
      const style = applyStylePreset(project, id, preset).annotations[0].style;
      expect(parseAnnotations([{ id: 'p', kind: preset.kinds[0], style }], canvas)[0].style).toEqual(style);
    }
  });

  test('active annotations follow their start and duration', () => {
    const p = addAnnotation(addAnnotation(p0, 'rect', 1).project, 'rect', 5).project;
    expect(activeAnnotationsAt(p, 0.5).length).toBe(0);
    expect(activeAnnotationsAt(p, 1).length).toBe(1);
    expect(activeAnnotationsAt(p, 4.99).length).toBe(1); // first ends at 5 (4 s long)
    expect(activeAnnotationsAt(p, 5).length).toBe(1);
    expect(activeAnnotationsAt(p, 9).length).toBe(0);
  });
});

describe('rescale', () => {
  test('resizing the canvas scales boxes, text, line widths and x / y keys', () => {
    let p = createProject('t', 1920, 1080);
    const { project, id } = addAnnotation(p, 'callout', 0);
    p = updateAnnotation(project, id, { keys: { x: [{ t: 0, v: 960, ease: 'linear' }], y: [{ t: 0, v: 540, ease: 'linear' }] } });
    const a0 = p.annotations[0];
    const q = resizeCanvas(p, 960, 540).annotations[0];
    expect(q.x).toBeCloseTo(a0.x / 2);
    expect(q.width).toBeCloseTo(a0.width / 2);
    expect(q.height).toBeCloseTo(a0.height / 2);
    expect(q.style.size).toBeCloseTo(a0.style.size / 2);
    expect(q.style.strokeWidth).toBeCloseTo(a0.style.strokeWidth / 2);
    expect(q.keys?.x?.[0].v).toBe(480);
    expect(q.keys?.y?.[0].v).toBe(270);
    expect(q.tail).toEqual(a0.tail);
    expect(rescaleAnnotations([], 2, 2)).toEqual([]);
    const same = [a0];
    expect(rescaleAnnotations(same, 1, 1)).toBe(same);
  });
});

describe('geometry', () => {
  test('keyframes drive the centre, scale, rotation and opacity', () => {
    const a = defaultAnnotation('rect', canvas, 10, 'a');
    a.keys = { x: [{ t: 0, v: 100, ease: 'linear' }, { t: 2, v: 500, ease: 'linear' }], opacity: [{ t: 0, v: 0, ease: 'linear' }, { t: 1, v: 1, ease: 'linear' }], scale: [{ t: 0, v: 2, ease: 'linear' }] };
    const r = resolveAnnotation(a, 11, canvas);
    expect(r.x).toBe(300);
    expect(r.y).toBe(a.y + a.height / 2);
    expect(r.opacity).toBe(1);
    expect(r.scale).toBe(2);
    expect(resolveAnnotation(a, 10, canvas).opacity).toBe(0);
    const plain = defaultAnnotation('rect', canvas, 0, 'b');
    expect(resolveAnnotation(plain, 3, canvas)).toEqual({ x: plain.x + plain.width / 2, y: plain.y + plain.height / 2, scale: 1, rotation: 0, opacity: 1 });
  });

  test('toLocal and fromLocal are inverses, with rotation and scale', () => {
    const r = { x: 400, y: 300, scale: 1.5, rotation: 30, opacity: 1 };
    const p = { x: 512, y: 377 };
    const back = fromLocal(r, toLocal(r, p));
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
    expect(toLocal({ ...r, rotation: 0, scale: 1 }, { x: 410, y: 290 })).toEqual({ x: 10, y: -10 });
  });

  test('hit testing: filled shapes by area, outlines and lines by stroke, callouts by tail', () => {
    const rect = { ...defaultAnnotation('rect', canvas, 0, 'r'), x: 100, y: 100, width: 200, height: 100 };
    expect(hitTestAnnotation(rect, { x: 200, y: 150 }, 0, canvas)).toBe(false); // outline only: the inside is not grabbed
    expect(hitTestAnnotation(rect, { x: 100, y: 150 }, 0, canvas)).toBe(true);
    const filled = { ...rect, style: { ...rect.style, fill: '#ff0000' } };
    expect(hitTestAnnotation(filled, { x: 200, y: 150 }, 0, canvas)).toBe(true);
    expect(hitTestAnnotation(filled, { x: 400, y: 150 }, 0, canvas)).toBe(false);
    const ell = { ...defaultAnnotation('highlight', canvas, 0, 'e'), x: 0, y: 0, width: 200, height: 100, shape: 'ellipse' as const };
    expect(hitTestAnnotation(ell, { x: 100, y: 50 }, 0, canvas)).toBe(true);
    expect(hitTestAnnotation(ell, { x: 4, y: 4 }, 0, canvas, 0)).toBe(false); // corner of the box, outside the ellipse
    const line = { ...defaultAnnotation('line', canvas, 0, 'l'), x: 0, y: 0, width: 100, height: 100, line: { x1: 0, y1: 0, x2: 1, y2: 1 } };
    expect(hitTestAnnotation(line, { x: 50, y: 52 }, 0, canvas)).toBe(true);
    expect(hitTestAnnotation(line, { x: 90, y: 10 }, 0, canvas)).toBe(false);
    const callout = { ...defaultAnnotation('callout', canvas, 0, 'c'), x: 100, y: 100, width: 200, height: 100, tail: { x: 0.5, y: 2 } };
    expect(hitTestAnnotation(callout, { x: 200, y: 300 }, 0, canvas)).toBe(true); // at the tail tip
    expect(hitTestAnnotation(callout, { x: 600, y: 300 }, 0, canvas)).toBe(false);
    expect(tailCanvas(callout, resolveAnnotation(callout, 0, canvas))).toEqual({ x: 200, y: 300 });
  });

  test('a rotated annotation is hit where it is drawn', () => {
    const a = { ...defaultAnnotation('highlight', canvas, 0, 'h'), x: 0, y: 0, width: 400, height: 20, rotation: 90 };
    // Centre (200, 10); rotated a quarter turn it is a tall thin bar.
    expect(hitTestAnnotation(a, { x: 200, y: 150 }, 0, canvas, 0)).toBe(true);
    expect(hitTestAnnotation(a, { x: 350, y: 10 }, 0, canvas, 0)).toBe(false);
  });

  test('line ends: patch from two points and back', () => {
    const patch = lineEndsPatch(300, 400, 100, 100);
    expect(patch).toMatchObject({ x: 100, y: 100, width: 200, height: 300, rotation: 0 });
    const a = { ...defaultAnnotation('arrow', canvas, 0, 'a'), ...patch };
    const e = lineCanvas(a, resolveAnnotation(a, 0, canvas));
    expect([e.x1, e.y1, e.x2, e.y2]).toEqual([300, 400, 100, 100]);
    // A flat line keeps a 1 px box.
    expect(lineEndsPatch(10, 50, 200, 50).height).toBe(1);
  });
});

describe('sketch motion', () => {
  test('progress runs 0..1 over the sketch time from the start, and only for drawable kinds', () => {
    const a = { kind: 'arrow' as const, start: 2, sketch: 2 };
    expect(sketchProgress(a, 2)).toBe(0);
    expect(sketchProgress(a, 3)).toBe(0.5);
    expect(sketchProgress(a, 4)).toBe(1);
    expect(sketchProgress(a, 99)).toBe(1);
    expect(sketchProgress(a, 1)).toBe(0);
    expect(sketchProgress({ ...a, sketch: 0 }, 2)).toBe(1);
    expect(sketchProgress({ kind: 'text', start: 0, sketch: 5 }, 1)).toBe(1);
    expect(sketchProgress({ kind: 'spotlight', start: 0, sketch: 5 }, 1)).toBe(1);
  });

  test('outline lengths', () => {
    const style = { radius: 0 };
    const line = { x1: 0, y1: 0, x2: 1, y2: 1 };
    expect(outlineLength({ kind: 'line', width: 30, height: 40, style, line })).toBeCloseTo(50);
    expect(outlineLength({ kind: 'rect', width: 100, height: 50, style, line })).toBeCloseTo(300);
    expect(outlineLength({ kind: 'rect', width: 100, height: 100, style: { radius: 50 }, line })).toBeCloseTo(2 * Math.PI * 50);
    expect(outlineLength({ kind: 'ellipse', width: 100, height: 100, style, line })).toBeCloseTo(2 * Math.PI * 50, 3);
    // A flat ellipse is roughly twice its long axis.
    expect(outlineLength({ kind: 'ellipse', width: 200, height: 2, style, line })).toBeGreaterThan(395);
  });
});

/** A stand-in 2D context that records the calls drawing makes, for checking what is drawn without a browser. */
function recorder() {
  const calls: string[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in state) return state[prop];
        if (prop === 'measureText') return (s: string) => ({ width: s.length * 10 });
        return (...args: unknown[]) => {
          calls.push(`${prop}(${args.map((a) => (Array.isArray(a) ? `[${a.map((n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : n)).join(',')}]` : String(a))).join(',')})`);
        };
      },
      set(_t, prop: string, value) {
        state[prop] = value;
        if (prop === 'fillStyle' || prop === 'strokeStyle' || prop === 'lineWidth') calls.push(`${prop}=${String(value)}`);
        return true;
      },
    },
  );
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('drawAnnotations (recorded)', () => {
  const host = (a: ReturnType<typeof defaultAnnotation>) => ({ annotations: [a], width: 1920, height: 1080 });

  test('nothing is drawn outside the annotation time', () => {
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, host({ ...defaultAnnotation('rect', canvas, 5, 'r') }), 4.9);
    drawAnnotations(ctx, host({ ...defaultAnnotation('rect', canvas, 5, 'r') }), 9);
    expect(calls.length).toBe(0);
  });

  test('every drawable kind draws something at its start without throwing', () => {
    for (const kind of ANNOTATION_KINDS.filter((k) => k !== 'spotlight')) {
      const { ctx, calls } = recorder();
      drawAnnotations(ctx, host(defaultAnnotation(kind, canvas, 0, 'x')), 1);
      expect(calls.some((c) => c.startsWith('stroke(') || c.startsWith('fill(') || c.startsWith('fillText('))).toBe(true);
    }
  });

  test('text is wrapped to the box and centred', () => {
    const { ctx, calls } = recorder();
    const a = { ...defaultAnnotation('text', canvas, 0, 't'), text: 'aaa bbb ccc', width: 80 + 2 * 20 };
    drawAnnotations(ctx, host(a), 0);
    expect(calls.filter((c) => c.startsWith('fillText(')).length).toBeGreaterThan(1);
  });

  test('sketch motion draws a partial dash at mid-time and the whole outline at the end', () => {
    const a = { ...defaultAnnotation('rect', canvas, 0, 'r'), sketch: 2, width: 100, height: 50 };
    a.style = { ...a.style, radius: 0 };
    const mid = recorder();
    drawAnnotations(mid.ctx, host(a), 1);
    const dash = mid.calls.find((c) => c.startsWith('setLineDash([') && !c.startsWith('setLineDash([])'));
    expect(dash).toBeDefined();
    expect(dash!.startsWith('setLineDash([150,')).toBe(true); // half of the 300 px outline
    const done = recorder();
    drawAnnotations(done.ctx, host(a), 2);
    expect(done.calls.some((c) => c.startsWith('setLineDash([]'))).toBe(true);
    expect(done.calls.some((c) => c.startsWith('setLineDash([1'))).toBe(false);
    // An arrow only reaches halfway at mid-time: its line stops short of the far end.
    const arrow = { ...defaultAnnotation('arrow', canvas, 0, 'a'), sketch: 2, width: 200, height: 1, line: { x1: 0, y1: 0.5, x2: 1, y2: 0.5 } };
    const half = recorder();
    drawAnnotations(half.ctx, host(arrow), 1);
    const lines = half.calls.filter((c) => c.startsWith('lineTo('));
    const xs = lines.map((c) => Number(c.slice(7).split(',')[0]));
    expect(Math.max(...xs)).toBeLessThanOrEqual(0 + 1); // the head's tip at the middle of the box (local x = 0)
  });
});
