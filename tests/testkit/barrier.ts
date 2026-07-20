export class Barrier {
  private readonly enteredCompletion = Promise.withResolvers<void>();
  private readonly releaseCompletion = Promise.withResolvers<void>();
  private reached = false;

  readonly entered = this.enteredCompletion.promise;

  async wait(): Promise<void> {
    if (!this.reached) {
      this.reached = true;
      this.enteredCompletion.resolve();
    }
    await this.releaseCompletion.promise;
  }

  release(): void {
    this.releaseCompletion.resolve();
  }
}
