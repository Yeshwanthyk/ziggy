const value: unknown = { name: "ziggy" };

export const typedValue = value as {
  name: string;
};
