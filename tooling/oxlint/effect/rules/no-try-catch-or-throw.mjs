import { isAdapterFile } from "../utils.mjs";

const tryCatchMessage =
  "Do not use try/catch blocks in Effect domain code. Model failures with Effect instead; at true adapter boundaries use a narrow suppression with a boundary reason. Skill: effect-typed-errors.";
const throwMessage =
  "Do not throw errors in Effect domain code. Model failures with Effect.fail or typed error values instead; at true adapter boundaries use a narrow suppression with a boundary reason. Skill: effect-typed-errors.";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow try/catch blocks and throw statements.",
    },
  },
  create(context) {
    if (isAdapterFile(context.filename)) return {};

    return {
      TryStatement(node) {
        context.report({ node, message: tryCatchMessage });
      },
      ThrowStatement(node) {
        context.report({ node, message: throwMessage });
      },
    };
  },
};
