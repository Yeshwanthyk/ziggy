import { isAdapterFile, isIdentifier, isStringLiteral } from "../utils.mjs";

const message =
  "Do not probe unknown object shapes in domain code. Normalize at a boundary with Schema, a typed adapter, or a named guard. Skill: effect-schema-boundaries.";

const isReflectGet = (node) =>
  node?.type === "MemberExpression" &&
  isIdentifier(node.object, "Reflect") &&
  isIdentifier(node.property, "get");

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
      CallExpression(node) {
        if (isReflectGet(node.callee)) {
          context.report({ node, message });
        }
      },
      BinaryExpression(node) {
        if (node.operator === "in" && isStringLiteral(node.left)) {
          context.report({ node, message });
        }
      },
    };
  },
};
