export interface ChunkTask {
  runChunk(deadline: number, maxUnits: number): boolean;
}

export const DEFAULT_CHUNK_BUDGET_MS = 8;
export const DEFAULT_CHUNK_MAX_UNITS = 8_192;

export class ChunkScheduler {
  #task: ChunkTask | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #paused = false;
  readonly #now: () => number;
  readonly #budgetMs: number;
  readonly #maxUnits: number;

  constructor({
    now = () => performance.now(),
    budgetMs = DEFAULT_CHUNK_BUDGET_MS,
    maxUnits = DEFAULT_CHUNK_MAX_UNITS,
  }: {
    now?: () => number;
    budgetMs?: number;
    maxUnits?: number;
  } = {}) {
    this.#now = now;
    this.#budgetMs = budgetMs;
    this.#maxUnits = maxUnits;
  }

  start(task: ChunkTask): void {
    this.cancel();
    this.#task = task;
    this.#paused = false;
    this.#schedule();
  }

  pause(): boolean {
    if (this.#task === null) return false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#paused = true;
    return true;
  }

  resume(): boolean {
    if (this.#task === null || !this.#paused) return false;
    this.#paused = false;
    this.#schedule();
    return true;
  }

  cancel(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#task = null;
    this.#paused = false;
  }

  get active(): boolean {
    return this.#task !== null;
  }

  #schedule(): void {
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const task = this.#task;
      if (task === null) return;
      const done = task.runChunk(this.#now() + this.#budgetMs, this.#maxUnits);
      if (this.#task !== task) return;
      if (done) this.#task = null;
      else if (!this.#paused) this.#schedule();
    }, 0);
  }
}
