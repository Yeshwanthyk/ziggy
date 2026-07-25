import { isAdapterFile, isIdentifier } from "../utils.mjs";

const message =
  "Do not use JSON.parse in domain code. Decode JSON with Schema.fromJsonString(...) and Schema.decodeUnknownEffect or decodeUnknownResult. Skill: effect-schema-boundaries.";

const isJsonParse = (node) =>
  node?.type === "MemberExpression" &&
  isIdentifier(node.object, "JSON") &&
  isIdentifier(node.property, "parse");

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
        if (isJsonParse(node.callee)) {
          context.report({ node, message });
        }
      },
    };
  },
};
