export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow unsafe TypeScript escape syntax",
    },
    messages: {
      noAny: "Explicit any is forbidden; model the value precisely or use unknown.",
      noAssertion: "Type assertions are forbidden; narrow, decode, or construct the type instead.",
      noNonNull: "Non-null assertions are forbidden; prove or handle nullability instead.",
    },
  },
  create(context) {
    return {
      TSAnyKeyword(node) {
        context.report({ messageId: "noAny", node });
      },
      TSAsExpression(node) {
        const annotation = node.typeAnnotation;
        const isConstAssertion =
          annotation.type === "TSTypeReference" &&
          annotation.typeName.type === "Identifier" &&
          annotation.typeName.name === "const" &&
          annotation.typeArguments === null;

        if (!isConstAssertion) {
          context.report({ messageId: "noAssertion", node });
        }
      },
      TSTypeAssertion(node) {
        context.report({ messageId: "noAssertion", node });
      },
      TSNonNullExpression(node) {
        context.report({ messageId: "noNonNull", node });
      },
    };
  },
};
