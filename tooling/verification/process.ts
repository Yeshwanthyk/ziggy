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
