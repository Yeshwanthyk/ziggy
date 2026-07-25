import { isAdapterFile, isIdentifier, nodeName } from "../utils.mjs";

const message =
  "Do not use instanceof for tagged errors. Use Effect.catchTag, Effect.catchTags, or Predicate.isTagged. Skill: effect-typed-errors.";

const looksLikeTaggedErrorName = (name) =>
  typeof name === "string" && name !== "Error" && name.endsWith("Error");

export default {
  meta: {
    type: "problem",
    docs: {
      description: message,
    },
  },
  create(context) {
    if (isAdapterFile(context.filename)) return {};

    return {
      BinaryExpression(node) {
        if (node.operator !== "instanceof") return;
        const rightName = nodeName(node.right);
        if (isIdentifier(node.right) && looksLikeTaggedErrorName(rightName)) {
          context.report({ node, message });
        }
      },
    };
  },
};
