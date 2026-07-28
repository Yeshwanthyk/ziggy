import { DiscordSocketError } from "./socket";

export const normalizeDiscordSocketError = (cause: unknown): DiscordSocketError =>
  cause instanceof DiscordSocketError ? cause : new DiscordSocketError("unexpected socket failure");
