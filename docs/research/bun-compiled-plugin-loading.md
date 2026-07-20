# Bun compiled executable runtime plugin test

Bun version: `1.3.13`

All commands and binaries were run from this report's directory. Runtime plugin paths passed to the executables were absolute paths. For tests 1, 2, 3, 4, and 6, the runtime-loaded source files did not exist when their executable was compiled; they were created only after compilation.

| Test                                              | Result                   | Observed behavior                                                                                                                                   |
| ------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a. Absolute dynamic import of post-compile `.ts` | **WORKS**                | Exit 0; printed `hello() -> TypeScript value=42`. The file contains TypeScript type annotations, so Bun transpiles TypeScript from disk at runtime. |
| 1b. Absolute dynamic import of post-compile `.js` | **WORKS**                | Exit 0; printed `hello() -> JavaScript loaded`.                                                                                                     |
| 2. Plugin relative import plus `node:os`          | **WORKS**                | Exit 0; printed `run() -> nested=7 platform=darwin`. The relative TypeScript dependency resolved from the plugin file, and the Node builtin loaded. |
| 3. Plugin-local npm package                       | **WORKS**                | Exit 0; printed `run() -> 007`. `left-pad@1.3.0` resolved from `node_modules` next to the plugin.                                                   |
| 4. `new Worker(pathToOnDiskFile)`                 | **WORKS**                | Exit 0; printed `worker message: TypeScript worker value=99`. The on-disk worker was TypeScript and was loaded at runtime.                          |
| 5. `Bun.Transpiler` plus `new Function` fallback  | **NOT RUN / NOT NEEDED** | The test was conditional on dynamic import failing, and dynamic import succeeded.                                                                   |
| 6a. Test 1 `.ts` with `--bytecode`                | **WORKS**                | Exit 0; printed `hello() -> TypeScript value=42`. No runtime-loading difference from test 1.                                                        |
| 6b. Test 1 `.js` with `--bytecode`                | **WORKS**                | Exit 0; printed `hello() -> JavaScript loaded`. No runtime-loading difference from test 1.                                                          |

## Commands and exact outputs

The version command was:

```text
$ bun --version
1.3.13
```

The ordinary builds used:

```text
$ bun build --compile test1/main.ts --outfile test1/main-exe
   [2ms]  bundle  1 modules
  [97ms] compile  test1/main-exe

$ bun build --compile test2/main.ts --outfile test2/main-exe
   [2ms]  bundle  1 modules
  [87ms] compile  test2/main-exe

$ bun build --compile test3/main.ts --outfile test3/main-exe
   [2ms]  bundle  1 modules
  [89ms] compile  test3/main-exe

$ bun build --compile test4/main.ts --outfile test4/main-exe
   [2ms]  bundle  1 modules
  [72ms] compile  test4/main-exe
```

The bytecode build used:

```text
$ bun build --compile --bytecode test1/main.ts --outfile test6/main-exe
  [52ms]  bundle  1 modules
  [73ms] compile  test6/main-exe
```

The runtime outputs were:

```text
$ ./test1/main-exe "$PWD/test1/plugin.ts"
hello() -> TypeScript value=42

$ ./test1/main-exe "$PWD/test1/plugin.js"
hello() -> JavaScript loaded

$ ./test2/main-exe "$PWD/test2/plugin.ts"
Attempting dynamic import of: <absolute-path>/test2/plugin.ts
Import succeeded. Exports: [ "run" ]
run() -> nested=7 platform=darwin

$ ./test3/main-exe "$PWD/test3/plugin-dir/plugin.ts"
Attempting dynamic import of: <absolute-path>/test3/plugin-dir/plugin.ts
Import succeeded. Exports: [ "run" ]
run() -> 007

$ ./test4/main-exe "$PWD/test4/worker.ts"
worker message: TypeScript worker value=99

$ ./test6/main-exe "$PWD/test1/plugin.ts"
hello() -> TypeScript value=42

$ ./test6/main-exe "$PWD/test1/plugin.js"
hello() -> JavaScript loaded
```

There were no test-case runtime or build failures, so there are no failure error messages to report.

## Conclusion

On Bun 1.3.13, a single-file compiled executable can load plugin code from disk at runtime. Viable strategies are absolute-path dynamic import of JavaScript or TypeScript, including TypeScript transpilation at runtime; plugins with nested relative imports and `node:` builtins; plugins whose bare npm imports resolve from a `node_modules` directory adjacent to the plugin; and `Worker` loading of an on-disk TypeScript file. Adding `--bytecode` did not change these dynamic-import results. A `Bun.Transpiler`/`new Function` fallback was unnecessary and was not evaluated.
