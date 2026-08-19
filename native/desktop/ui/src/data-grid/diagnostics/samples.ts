// Percentiles retain the latest 2,048 values, or about 34 seconds at 60 Hz.
// Count and max still cover the whole recording. A fixed limit bounds memory and
// keeps reports comparable.
const SAMPLE_LIMIT = 2_048;

export class NumericSamples {
  private readonly values = new Float64Array(SAMPLE_LIMIT);
  private next = 0;
  private size = 0;
  private count = 0;
  private maximum = 0;

  add(value: number) {
    if (!Number.isFinite(value) || value < 0) return;
    this.values[this.next] = value;
    this.next = (this.next + 1) % SAMPLE_LIMIT;
    this.size = Math.min(SAMPLE_LIMIT, this.size + 1);
    this.count += 1;
    this.maximum = Math.max(this.maximum, value);
  }

  report() {
    const sorted = this.sorted();
    return {
      count: this.count,
      sampleCount: this.size,
      p50: roundMilliseconds(percentile(sorted, 0.5)),
      p95: roundMilliseconds(percentile(sorted, 0.95)),
      p99: roundMilliseconds(percentile(sorted, 0.99)),
      max: roundMilliseconds(this.count === 0 ? 0 : this.maximum),
    };
  }

  percentile(value: number): number {
    return percentile(this.sorted(), value);
  }

  get sampleCount(): number {
    return this.size;
  }

  clear() {
    this.next = 0;
    this.size = 0;
    this.count = 0;
    this.maximum = 0;
  }

  private sorted(): number[] {
    return Array.from(this.values.slice(0, this.size)).sort(
      (left, right) => left - right,
    );
  }
}

export function percentile(
  sorted: readonly number[],
  percentileValue: number,
): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? 0;
}

export function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function roundHertz(value: number): number {
  return Math.round(value * 10) / 10;
}
