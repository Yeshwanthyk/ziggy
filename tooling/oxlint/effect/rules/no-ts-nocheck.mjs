const directivePattern = new RegExp(`@ts-${"nocheck"}\\b`);
const directiveName = `@ts-${"nocheck"}`;

export default {
  meta: {
    type: "problem",
    docs: {
      description: `Disallow ${directiveName} directives.`,
    },
  },
  create(context) {
    return {
      Program(node) {
        for (const comment of node.comments) {
          if (!directivePattern.test(comment.value)) continue;

          context.report({
            node: comment,
            message: `Do not use ${directiveName}; fix the types or narrow the file scope. Skill: wrdn-typescript-type-safety.`,
          });
        }
      },
    };
  },
};
