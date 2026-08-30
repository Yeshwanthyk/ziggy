import { create } from "./dom";

type IdentityPreset = { path: string; fill: string; eye: string; mouth: string };

const identityPresets: Readonly<Record<string, IdentityPreset>> = {
  squarey: {
    path: "M4 17.4C2.7 13.4 4.1 5.7 8.3 3.2c4.1-2.4 11.3-.7 13.7 3.1 2.5 4 .4 10.2-3.7 13-4.2 2.8-12.8 2.1-14.3-1.9Z",
    fill: "#bad77d",
    eye: "#20261d",
    mouth: "M9 15.7c1.8 1.4 4.3 1.4 6.1 0",
  },
  sage: {
    path: "M4.2 14.8C2.5 10.1 6 4 10.2 3.2c4.2-.8 10.2 2.8 10.8 7.1.6 4.1-3.2 9.3-7.8 10.2-4.5.9-7.4-1.1-9-5.7Z",
    fill: "#a9c9e8",
    eye: "#1f2735",
    mouth: "M9.1 15.5c1.8.9 3.6.9 5.7-.1",
  },
  scout: {
    path: "M3.3 10.2C4 5.5 9.1 2.8 13.7 3.6c4.8.9 8.7 5.2 7.8 9.8-.9 4.7-6 8.2-10.7 7.5-4.9-.8-8.2-6-7.5-10.7Z",
    fill: "#e5a8ca",
    eye: "#33202e",
    mouth: "M9.6 15.1c1.5 1.8 3.6 2 5.3.2",
  },
  group: {
    path: "M3.8 15.8C2 11.9 4.5 5.1 8.6 3.4c4-1.7 10.8.8 12.4 5.3 1.4 4.4-1.9 9.8-6.3 11.4-4.3 1.6-9.1-.5-10.9-4.3Z",
    fill: "#d7b47d",
    eye: "#2d261c",
    mouth: "M8.6 15.3c2 1.2 4.6 1.2 6.5-.3",
  },
  channel: {
    path: "M4.4 16.8C2.5 12.1 5.3 5.2 9.7 3.7c4.6-1.6 10.2 1.2 11.2 5.8 1 4.7-2.8 9.3-7.4 10.4-4.3 1.1-7.2-1-9.1-3.1Z",
    fill: "#a8c3b2",
    eye: "#1e2a27",
    mouth: "M9.1 15.3c1.8 1.1 3.8.9 5.8-.2",
  },
};

export const identitySvg = (
  id: string,
  size: "small" | "medium" | "large" = "small",
): HTMLElement => {
  const preset = identityPresets[id] ?? identityPresets.squarey;
  if (preset === undefined) throw new Error("Missing default identity preset");
  const wrapper = create("span", `avatar avatar-${size}`);
  wrapper.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 26 26");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", preset.path);
  path.setAttribute("fill", preset.fill);
  const animate = document.createElementNS("http://www.w3.org/2000/svg", "animateTransform");
  animate.setAttribute("attributeName", "transform");
  animate.setAttribute("type", "rotate");
  animate.setAttribute("values", "-2 13 13;2 13 13;-2 13 13");
  animate.setAttribute("dur", "5.5s");
  animate.setAttribute("repeatCount", "indefinite");
  path.append(animate);
  svg.append(path);
  const leftEye = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  leftEye.setAttribute("cx", "10");
  leftEye.setAttribute("cy", "11.4");
  leftEye.setAttribute("r", "1.05");
  leftEye.setAttribute("fill", preset.eye);
  const rightEye = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  rightEye.setAttribute("cx", "15.8");
  rightEye.setAttribute("cy", "11.4");
  rightEye.setAttribute("r", "1.05");
  rightEye.setAttribute("fill", preset.eye);
  const mouth = document.createElementNS("http://www.w3.org/2000/svg", "path");
  mouth.setAttribute("d", preset.mouth);
  mouth.setAttribute("fill", "none");
  mouth.setAttribute("stroke", preset.eye);
  mouth.setAttribute("stroke-linecap", "round");
  mouth.setAttribute("stroke-width", "1.05");
  svg.append(leftEye, rightEye, mouth);
  wrapper.append(svg);
  return wrapper;
};
