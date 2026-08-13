import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";
import type { ObjectEncodingOptions, PathOrFileDescriptor } from "node:fs";
import { Predicate } from "effect";
import { compiledAssetPath, piBuiltinPhotonWasmPath } from "./tui-themes";

const photonWasmFilename = "photon_rs_bg.wasm";

const isPhotonWasmPath = (file: PathOrFileDescriptor): boolean =>
  Predicate.isString(file)
    ? file.endsWith(photonWasmFilename)
    : file instanceof URL && file.pathname.endsWith(photonWasmFilename);

type ReadFileOptions = BufferEncoding | ObjectEncodingOptions | null | undefined;

const readFileWithOptions = (
  readFileSync: typeof import("node:fs").readFileSync,
  file: PathOrFileDescriptor,
  options: ReadFileOptions,
): Buffer | string => {
  if (options === undefined || options === null) return readFileSync(file, options);
  if (Predicate.isString(options)) return readFileSync(file, options);
  const encoding = options.encoding;
  if (encoding === undefined || encoding === null) return readFileSync(file, options);
  return readFileSync(file, { ...options, encoding });
};

/** Make Pi's Photon loader fall back to the WASM embedded in the one-file executable. */
export const installCompiledPhotonWasmFallback = (
  fileSystem: Pick<typeof import("node:fs"), "readFileSync"> = process.getBuiltinModule("fs"),
  wasmPath: string = piBuiltinPhotonWasmPath,
): void => {
  const originalReadFileSync = fileSystem.readFileSync.bind(fileSystem);
  const patchedReadFileSync = (
    file: PathOrFileDescriptor,
    options?: ReadFileOptions,
  ): Buffer | string => {
    try {
      return readFileWithOptions(originalReadFileSync, file, options);
    } catch (cause) {
      if (
        !isPhotonWasmPath(file) ||
        !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      ) {
        throw cause;
      }
      return readFileWithOptions(originalReadFileSync, wasmPath, options);
    }
  };
  Object.defineProperty(fileSystem, "readFileSync", {
    configurable: true,
    value: patchedReadFileSync,
    writable: true,
  });
};

/** Mirror the static provider registrations used by Pi's pinned Bun executable entrypoint. */
export const registerPiStandaloneRuntime = (): void => {
  installCompiledPhotonWasmFallback();
  registerBunOAuthFlows();
  setBedrockProviderModule(bedrockProviderModule);
};

/** Register Bun OAuth and Bedrock only when this Ziggy process is a compiled Bun binary. */
export const bootstrapPiStandaloneRuntime = (
  runtimeUrl: string = import.meta.url,
  register: () => void = registerPiStandaloneRuntime,
): void => {
  if (!compiledAssetPath(runtimeUrl)) return;
  register();
};
