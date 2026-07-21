import { getPropertyName, isIdentifier, typeReferenceName, unwrapExpression } from "../utils.mjs";

const message =
  "Migrated domain code must not own native Promise control flow. Keep pure synchronous TypeScript synchronous; model asynchronous work with Effect and isolate forced Promise APIs in an approved adapter. Skill: wrdn-effect-runtime-boundaries.";

const isFunction = (node) =>
  node?.type === "FunctionDeclaration" ||
  node?.type === "FunctionExpression" ||
  node?.type === "ArrowFunctionExpression";

const isPromiseType = (node) => {
  const name = typeReferenceName(node);
  return name === "Promise" || name === "globalThis.Promise";
};

const isPromiseConstructor = (node) =>
  isIdentifier(unwrapExpression(node), "Promise") ||
  (unwrapExpression(node)?.type === "MemberExpression" &&
    isIdentifier(unwrapExpression(unwrapExpression(node).object), "globalThis") &&
    getPropertyName(unwrapExpression(node).property) === "Promise");

const isPromiseStaticCall = (node) => {
  const expression = unwrapExpression(node);
  return expression?.type === "MemberExpression" && isPromiseConstructor(expression.object);
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow native Promise ownership in migrated domain code.",
    },
  },
  create(context) {
    return {
      FunctionDeclaration(node) {
        if (node.async) context.report({ node, message });
      },
      FunctionExpression(node) {
        if (node.async) context.report({ node, message });
      },
      ArrowFunctionExpression(node) {
        if (node.async) context.report({ node, message });
      },
      AwaitExpression(node) {
        let current = node.parent;
        while (current && !isFunction(current)) current = current.parent;
        if (!current) context.report({ node, message });
      },
      TSTypeReference(node) {
        if (isPromiseType(node)) context.report({ node, message });
      },
      NewExpression(node) {
        if (isPromiseConstructor(node.callee)) context.report({ node, message });
      },
      CallExpression(node) {
        if (isPromiseStaticCall(node.callee)) context.report({ node, message });
      },
    };
  },
};
