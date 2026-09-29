export type DiscordWebSocketMessageData = string | Uint8Array;

export interface DiscordSocketConnection {
  readonly readyState: () => number;
  readonly send: (data: string) => void;
  readonly close: (code?: number) => void;
  readonly onOpen: (listener: () => void) => () => void;
  readonly onMessage: (listener: (data: DiscordWebSocketMessageData) => void) => () => void;
  readonly onError: (listener: () => void) => () => void;
  readonly onClose: (listener: (code: number) => void) => () => void;
}

const normalizeWebSocketMessageData = (
  data: MessageEvent["data"],
): DiscordWebSocketMessageData | undefined => {
  if (ArrayBuffer.isView(data)) {
    return data instanceof Uint8Array
      ? data
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (data instanceof Blob) {
    return undefined;
  }

  return data;
};

export const liveConnection = (url: string): DiscordSocketConnection => {
  const socket = new WebSocket(url);

  return {
    readyState: () => socket.readyState,
    send: (data) => socket.send(data),
    close: (code) => socket.close(code),
    onOpen: (listener) => {
      socket.addEventListener("open", listener);

      return () => socket.removeEventListener("open", listener);
    },
    onMessage: (listener) => {
      const handle = (event: MessageEvent) => {
        const data = normalizeWebSocketMessageData(event.data);

        if (data !== undefined) {
          listener(data);
        }
      };

      socket.addEventListener("message", handle);

      return () => socket.removeEventListener("message", handle);
    },
    onError: (listener) => {
      socket.addEventListener("error", listener);

      return () => socket.removeEventListener("error", listener);
    },
    onClose: (listener) => {
      const handle = (event: CloseEvent) => listener(event.code);
      socket.addEventListener("close", handle);

      return () => socket.removeEventListener("close", handle);
    },
  };
};
