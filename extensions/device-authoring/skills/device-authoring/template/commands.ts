// Commands this device lends the Profile. Each reaches the model as `device__<id>__<name>`.
// Run on the device with `ziggy-device run --state device.json --commands commands.ts`.
import type { Device } from "./device";

/** Replace with the device's own state and hardware access. */
let count = 0;

export default (device: Device): void => {
  device.command(
    "counter_add",
    {
      description: "Add to the example counter and return the new total.",
      inputSchema: {
        type: "object",
        properties: { amount: { type: "integer", minimum: 1 } },
        required: ["amount"],
      },
    },
    ({ amount }) => {
      if (typeof amount !== "number") throw new Error("amount must be a number");

      count += amount;

      return `the counter is ${count}`;
    },
  );

  device.command(
    "counter_read",
    { description: "Read the example counter." },
    () => `the counter is ${count}`,
  );
};
