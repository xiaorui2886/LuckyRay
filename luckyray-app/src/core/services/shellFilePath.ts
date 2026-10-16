/** Restore Windows verbatim syntax at the OS boundary. Catalog paths use '/';
 * Rust otherwise reads //?/C:/ as UNC (?, C:) and the opener cannot simplify it.
 * Keep the prefix: the native opener decides when it is safe to simplify it.
 */
export function shellFilePath(path: string, platform = globalThis.navigator?.platform ?? ""): string {
  return platform.startsWith("Win") && /^(?:\/\/\?\/|\\\\\?\\)/.test(path)
    ? path.replace(/\//g, "\\")
    : path;
}
