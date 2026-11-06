import { confirm as hostConfirm } from "@tauri-apps/plugin-dialog";
import type { ExtensionPackage, InstalledPackage } from "../../core/extensions/packages";

type Copy = (key: "pack.publisher.install" | "pack.publisher.update", values: Record<string, string>) => string;

/** null means the user cancelled; false means verified continuity needs no decision. */
export async function confirmPublisher(previous: InstalledPackage | undefined, next: ExtensionPackage, t: Copy): Promise<boolean | null> {
  const candidate = typeof next.signature?.publicKey === "string" ? next.signature.publicKey : "";
  if (!previous && !next.signature) return false;
  if (previous && previous.trustedPublisher && previous.trustedPublisher === candidate) return false;
  if (previous && JSON.stringify(previous.package) === JSON.stringify(next)) return false;
  const message = t(previous ? "pack.publisher.update" : "pack.publisher.install", {
    name: next.manifest.name,
    oldKey: previous?.trustedPublisher || "—",
    newKey: candidate.slice(0, 128) || "—",
  });
  const accepted = "__TAURI_INTERNALS__" in window
    ? await hostConfirm(message, { title: "LuckyRay", kind: "warning" })
    : Boolean(await Promise.resolve(window.confirm(message)));
  return accepted ? true : null;
}
