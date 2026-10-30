// Preview tools: each editable thing on the picture (clips, blur regions, annotations, zoom boxes,
// the crop frame) is a tool. A tool claims pointer presses on the canvas and draws its own
// selection boxes and handles, so the Preview component never needs to know about them.
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { Editor } from './useEditor';

export interface Point {
  x: number;
  y: number;
}

/** A drag in progress. `move` previews the edit; `end` records it as one undo step. */
export interface DragSession {
  move(p: Point): void;
  end(): void;
}

export interface ToolContext {
  editor: Editor;
  time: number;
  /** Preview pixels per canvas pixel. */
  k: number;
  /** Canvas coordinates of a pointer event. */
  toCanvas(e: { clientX: number; clientY: number }): Point;
  /** Starts a drag from a handle's own pointer-down. */
  beginDrag(e: ReactPointerEvent, session: DragSession): void;
}

export interface PreviewTool {
  id: string;
  /**
   * A press on the canvas at `p`. Return a session to start dragging, 'handled' to claim the press
   * (for example to select something that cannot be dragged), or null to let the next tool try.
   */
  pointerDown?(ctx: ToolContext, p: Point): DragSession | 'handled' | null;
  /** Elements laid over the canvas for the current selection. Positioned in preview pixels (canvas pixels * k). */
  overlay?(ctx: ToolContext): ReactNode;
}

// A drag session outlives the render that started it, so `end` must read the latest project with
// `editor.getProject()`, never `editor.project` from the closure.
