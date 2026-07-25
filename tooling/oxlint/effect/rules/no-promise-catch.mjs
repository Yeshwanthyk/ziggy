import { getPropertyName, isAdapterFile, isIdentifier, unwrapExpression } from "../utils.mjs";

const message =
  "Do not use Promise .catch(). Model async failures with Effect.tryPromise and typed Effect error handling. Skill: effect-typed-errors.";

const isCatchMember = (node) => {
  const expression = unwrapExpression(node);
  if (isIdentifier(unwrapExpression(expression?.object), "Effect")) return false;
  return (
    expression?.type === "MemberExpression" && getPropertyName(expression.property) === "catch"
  );
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Promise-style .catch() error handling.",
    },
  },
  create(context) {
    if (isAdapterFile(context.filename)) return {};

    return {
      CallExpression(node) {
        if (isCatchMember(node.callee)) {
          context.report({ node, message });
        }
      },
    };
  },
};
