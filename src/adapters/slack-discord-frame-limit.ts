// Socket strings are bounded in UTF-16 code units; binary frames in bytes.
// Both limits leave room for large Discord GUILD_CREATE snapshots.
export const MAX_CHAT_FRAME_SIZE = 8 * 1_024 * 1_024;
