export class ToolScheduler {
  private readonly startedNames: string[] = [];
  private readonly completions = new Map<string, PromiseWithResolvers<void>>();
  private readonly waiters: Array<{
    readonly names: ReadonlyArray<string>;
    readonly completion: PromiseWithResolvers<void>;
  }> = [];

  readonly completionOrder: string[] = [];

  async run(name: string): Promise<void> {
    if (this.completions.has(name)) {
      throw new Error(`Tool ${name} was scheduled twice`);
    }
    const completion = Promise.withResolvers<void>();
    this.completions.set(name, completion);
    this.startedNames.push(name);
    this.resolveWaiters();
    await completion.promise;
    this.completionOrder.push(name);
  }

  waitForStarted(names: ReadonlyArray<string>): Promise<void> {
    if (names.every((name) => this.startedNames.includes(name))) {
      return Promise.resolve();
    }
    const completion = Promise.withResolvers<void>();
    this.waiters.push({ names: [...names], completion });
    return completion.promise;
  }

  complete(name: string): void {
    const completion = this.completions.get(name);
    if (completion === undefined) {
      throw new Error(`Tool ${name} has not started`);
    }
    completion.resolve();
  }

  private resolveWaiters(): void {
    for (const waiter of this.waiters) {
      if (waiter.names.every((name) => this.startedNames.includes(name))) {
        waiter.completion.resolve();
      }
    }
  }
}
