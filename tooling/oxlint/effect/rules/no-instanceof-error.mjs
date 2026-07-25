import { isAdapterFile, nodeName } from "../utils.mjs";

const message =
  "Do not use instanceof Error. Preserve typed failures with Effect tagged-error handling. Skill: effect-typed-errors.";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow instanceof Error checks.",
    },
  },
  create(context) {
    if (isAdapterFile(context.filename)) return {};

    return {
      BinaryExpression(node) {
        if (node.operator === "instanceof" && nodeName(node.right) === "Error") {
          context.report({ node, message });
        }
      },
    };
  },
};
