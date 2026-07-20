interface Clock {
  now(): Date;
}

export class FixedClock implements Clock {
  private currentMilliseconds: number;

  constructor(isoTimestamp: string) {
    const milliseconds = Date.parse(isoTimestamp);
    if (!Number.isFinite(milliseconds)) {
      throw new Error(`invalid fixed timestamp: ${isoTimestamp}`);
    }
    this.currentMilliseconds = milliseconds;
  }

  now(): Date {
    return new Date(this.currentMilliseconds);
  }

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error("clock advance must be a non-negative finite number");
    }
    this.currentMilliseconds += milliseconds;
  }
}

interface IdSource {
  next(): string;
}

export class SequenceIds implements IdSource {
  private index = 0;

  constructor(private readonly values: ReadonlyArray<string>) {}

  next(): string {
    const value = this.values[this.index];
    if (value === undefined) {
      throw new Error("deterministic ID sequence exhausted");
    }
    this.index += 1;
    return value;
  }
}

export class FilesystemFaultPlan {
  private readonly remaining: string[];

  constructor(points: ReadonlyArray<string>) {
    this.remaining = [...points];
  }

  reach(point: string): void {
    if (this.remaining[0] !== point) {
      return;
    }
    this.remaining.shift();
    throw new Error(`injected filesystem fault at ${point}`);
  }

  pending(): ReadonlyArray<string> {
    return [...this.remaining];
  }
}

export interface ProcessRequest {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export class CommandRecorder implements ProcessRunner {
  readonly commands: ProcessRequest[] = [];
  private result: ProcessResult;

  constructor(result: ProcessResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false }) {
    this.result = result;
  }

  respondWith(result: ProcessResult): void {
    this.result = result;
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.commands.push({
      argv: [...request.argv],
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
    });
    return { ...this.result };
  }
}
