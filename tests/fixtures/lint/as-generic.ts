const value: unknown = Promise.resolve("value");

export const typedValue = value as Promise<string>;
