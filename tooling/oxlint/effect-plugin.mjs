import noConditionalTests from "./effect/rules/no-conditional-tests.mjs";
import noEffectEscapeHatch from "./effect/rules/no-effect-escape-hatch.mjs";
import noEffectExecutionBoundary from "./effect/rules/no-effect-execution-boundary.mjs";
import noErrorConstructor from "./effect/rules/no-error-constructor.mjs";
import noInlineSchemaCompile from "./effect/rules/no-inline-schema-compile.mjs";
import noInstanceofError from "./effect/rules/no-instanceof-error.mjs";
import noInstanceofTaggedError from "./effect/rules/no-instanceof-tagged-error.mjs";
import noJsonParse from "./effect/rules/no-json-parse.mjs";
import noMatchOrelse from "./effect/rules/no-match-orelse.mjs";
import noNativePromiseOwnership from "./effect/rules/no-native-promise-ownership.mjs";
import noPromiseCatch from "./effect/rules/no-promise-catch.mjs";
import noRawFetch from "./effect/rules/no-raw-fetch.mjs";
import noTryCatchOrThrow from "./effect/rules/no-try-catch-or-throw.mjs";
import noTsNocheck from "./effect/rules/no-ts-nocheck.mjs";
import noUnsupportedEffectApi from "./effect/rules/no-unsupported-effect-api.mjs";
import preferYieldTaggedError from "./effect/rules/prefer-yield-tagged-error.mjs";

export default {
  meta: { name: "ziggy-effect" },
  rules: {
    "no-conditional-tests": noConditionalTests,
    "no-effect-escape-hatch": noEffectEscapeHatch,
    "no-effect-execution-boundary": noEffectExecutionBoundary,
    "no-error-constructor": noErrorConstructor,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-instanceof-error": noInstanceofError,
    "no-instanceof-tagged-error": noInstanceofTaggedError,
    "no-json-parse": noJsonParse,
    "no-match-orelse": noMatchOrelse,
    "no-native-promise-ownership": noNativePromiseOwnership,
    "no-promise-catch": noPromiseCatch,
    "no-raw-fetch": noRawFetch,
    "no-try-catch-or-throw": noTryCatchOrThrow,
    "no-ts-nocheck": noTsNocheck,
    "no-unsupported-effect-api": noUnsupportedEffectApi,
    "prefer-yield-tagged-error": preferYieldTaggedError,
  },
};
