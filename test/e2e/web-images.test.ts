import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchProfile } from "../harness/profile";
import { startModelServer } from "../harness/provider";
import { startResident, stopResidents } from "../harness/resident";
import { eventually } from "../harness/eventually";

// A valid one-pixel PNG exercises Pi's image processing as well as the upload route.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

test("web image-only prompts reach Pi and persist an image count, and uploads cannot be reused", async () => {
  const server = startModelServer();
  const profile = await scratchProfile(server);

  let expectedExitCodes: Array<number> = [];

  try {
    await writeFile(
      join(profile.path, "models.json"),
      JSON.stringify({
        providers: {
          harness: {
            baseUrl: server.baseUrl,
            api: "openai-completions",
            apiKey: "harness-key",
            models: [{ id: "harness-model", input: ["text", "image"] }],
          },
        },
      }),
    );
    const resident = await startResident(profile);
    expectedExitCodes = [0];
    const client = await resident.connect();
    const ref = await client.gateway.openMain(client.profileId);
    await client.gateway.watchSession(ref);

    const id = await client.gateway.uploadImage(
      new Blob([Buffer.from(png, "base64")], { type: "image/png" }),
    );

    await client.gateway.submitPrompt(ref, "", "image-only", { images: [id] });
    await eventually("image turn settled", () =>
      client.events.some((event) => event.event === "settled"),
    );
    expect(server.requests).toHaveLength(1);
    expect(server.request(0).messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "image_url",
            image_url: expect.objectContaining({
              url: expect.stringContaining("data:image/png;base64,"),
            }),
          }),
        ]),
      }),
    );
    const history = await client.gateway.getSessionHistory(ref);
    expect(history.entries).toContainEqual(
      expect.objectContaining({ kind: "user", imageCount: 1 }),
    );
    await expect(
      client.gateway.submitPrompt(ref, "again", "reused-image", { images: [id] }),
    ).rejects.toMatchObject({ code: "bad_params" });
    expect(server.requests).toHaveLength(1);
  } finally {
    const exitCodes = await stopResidents();
    server.stop();
    await profile.remove();
    expect(exitCodes).toEqual(expectedExitCodes);
  }
});
