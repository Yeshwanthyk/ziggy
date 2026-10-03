"""Muse's Python Noise_XX on the other end of Ziggy's, over stdin/stdout hex lines.

Usage: uv run --with cryptography python noise-interop.py <muse-gadget-sdk> <initiator|responder>
"""

import sys

sys.path.insert(0, f"{sys.argv[1]}/linux/src")
from musegadget.noise.noise_xx import NoiseXXInitiator, NoiseXXResponder  # noqa: E402


def recv() -> bytes:
    return bytes.fromhex(sys.stdin.readline().strip())


def send(data: bytes) -> None:
    print(data.hex(), flush=True)


if sys.argv[2] == "initiator":
    hs = NoiseXXInitiator()
    hs.initialize()
    send(hs.write_message1())
    hs.read_message2(recv())
    send(hs.write_message3())
    handshake_hash = hs.handshake_hash()  # split() zeroes it
    tx, rx = hs.split()
else:
    hs = NoiseXXResponder(payload=b"")
    hs.initialize()
    send(hs.read_message1_and_write_message2(recv()))
    hs.read_message3(recv())
    handshake_hash = hs.handshake_hash()
    tx, rx = hs.split()

send(handshake_hash)
message = rx.decrypt_with_ad(b"", recv())
send(tx.encrypt_with_ad(b"", b"muse heard: " + message))
