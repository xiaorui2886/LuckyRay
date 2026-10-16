import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
      for (const extension of [".ts", ".tsx"]) {
        try {
          return nextResolve(`${specifier}${extension}`, context);
        } catch (candidateError) {
          if (candidateError?.code !== "ERR_MODULE_NOT_FOUND") throw candidateError;
        }
      }
      throw error;
    }
  },
});
