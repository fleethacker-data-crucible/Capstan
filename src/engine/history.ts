// Snapshot undo/redo. Projects are immutable, so a snapshot is just a reference.
import type { Project } from './project';

export class History {
  private past: Project[] = [];
  private future: Project[] = [];
  constructor(private limit = 200) {}

  /** Records `before` as an undo point once `after` differs from it. */
  record(before: Project, after: Project): void {
    if (before === after) return;
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: Project): Project | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(current);
    return prev;
  }

  redo(current: Project): Project | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    return next;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
