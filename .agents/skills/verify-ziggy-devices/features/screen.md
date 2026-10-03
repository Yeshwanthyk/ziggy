# Screen

What Ziggy shows on a small screen is readable: text wraps, images fit, views render at the
device's resolution.

## Behaviors

- **S1** A long reply wraps and pages on a 320×240 screen.
- **S2** An MCP Apps view renders to an image at the reported resolution and is legible.
- **S3** An image larger than the screen is scaled, never cropped silently.

## User entry points

- Replies; `display.show`; views returned by plugin tools.

## Drive

Not built (S10).

## Proof

The rendered image file saved by the hub; a photo of the device screen.

## Gotchas

- The fake device can only prove the bytes and dimensions; legibility needs the board or a
  screenshot of the simulator.
