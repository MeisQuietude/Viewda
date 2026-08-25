import { afterEach, describe, expect, it, vi } from "vitest";

import { ChunkScheduler } from "./chunk-scheduler";

afterEach(() => vi.useRealTimers());

describe("ChunkScheduler", () => {
  it("gives each scheduled tick a fresh time deadline", () => {
    vi.useFakeTimers();
    let time = 10;
    const deadlines: number[] = [];
    const scheduler = new ChunkScheduler({ now: () => time, budgetMs: 8 });
    scheduler.start({
      runChunk: (deadline) => {
        deadlines.push(deadline);
        time += 12;
        return deadlines.length === 2;
      },
    });

    vi.runAllTimers();

    expect(deadlines).toEqual([18, 30]);
  });

  it("supplies a hard unit budget when the monotonic clock is frozen", () => {
    vi.useFakeTimers();
    const chunks: number[] = [];
    let remaining = 600;
    const scheduler = new ChunkScheduler({ now: () => 10, maxUnits: 128 });
    scheduler.start({
      runChunk: (_deadline, maxUnits) => {
        const worked = Math.min(remaining, maxUnits);
        chunks.push(worked);
        remaining -= worked;
        return remaining === 0;
      },
    });

    vi.runAllTimers();

    expect(chunks).toEqual([128, 128, 128, 128, 88]);
  });

  it("yields between chunks and resumes a paused task", () => {
    vi.useFakeTimers();
    const scheduler = new ChunkScheduler();
    const chunks: number[] = [];
    scheduler.start({
      runChunk: () => {
        chunks.push(chunks.length + 1);
        return chunks.length === 3;
      },
    });

    expect(chunks).toEqual([]);
    vi.advanceTimersToNextTimer();
    expect(chunks).toEqual([1]);
    expect(scheduler.pause()).toBe(true);
    vi.runAllTimers();
    expect(chunks).toEqual([1]);
    expect(scheduler.resume()).toBe(true);
    vi.runAllTimers();
    expect(chunks).toEqual([1, 2, 3]);
    expect(scheduler.active).toBe(false);
  });

  it("does not run a stale task after replacement or cancellation", () => {
    vi.useFakeTimers();
    const scheduler = new ChunkScheduler();
    const stale = vi.fn(() => false);
    const current = vi.fn(() => true);
    scheduler.start({ runChunk: stale });
    scheduler.start({ runChunk: current });
    vi.runAllTimers();
    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();

    scheduler.start({ runChunk: stale });
    scheduler.cancel();
    vi.runAllTimers();
    expect(stale).not.toHaveBeenCalled();
  });

  it("keeps a replacement started from the completing chunk", () => {
    vi.useFakeTimers();
    const scheduler = new ChunkScheduler();
    const replacement = vi.fn(() => true);
    scheduler.start({
      runChunk: () => {
        scheduler.start({ runChunk: replacement });
        return true;
      },
    });

    vi.runAllTimers();

    expect(replacement).toHaveBeenCalledOnce();
    expect(scheduler.active).toBe(false);
  });
});
