export async function loadValue(): Promise<string> {
  return Promise.resolve("ziggy");
}

export const makeValue = () => new Promise<string>((resolve) => resolve("ziggy"));

export const loadAll = (values: ReadonlyArray<Promise<string>>) => Promise.all(values);
