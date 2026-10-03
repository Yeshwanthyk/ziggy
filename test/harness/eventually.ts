/**
 * Polls `check` every 10 ms until it returns a value, or fails after `ms`. `undefined`, `null` and
 * `false` mean "not yet", so a boolean condition waits instead of passing on the first poll.
 */
export const eventually = async <Value>(
  label: string,
  check: () => Value | undefined | null | false | Promise<Value | undefined | null | false>,
  ms = 4_000,
): Promise<Value> => {
  const deadline = Date.now() + ms;

  for (;;) {
    const value = await check();

    if (value !== undefined && value !== null && value !== false) return value;

    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
};
