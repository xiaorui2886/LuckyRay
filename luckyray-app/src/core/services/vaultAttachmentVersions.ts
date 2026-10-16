export type AttachmentFileVersion = { path: string; version: string | null };
/** Poll only the native supplied set of registered files; never enumerate directories. */
export function createAttachmentVersionPoller(port: {
  current: () => object | null;
  source: object;
  read: () => Promise<{ versions: AttachmentFileVersion[] }>;
  changed: (paths: string[]) => void;
}) {
  let previous: Map<string, string | null> | null = null;
  let disposed = false,
    running = false;
  return {
    dispose() {
      disposed = true;
    },
    async poll() {
      if (disposed || running || port.current() !== port.source) return;
      running = true;
      try {
        const result = await port.read();
        if (disposed || port.current() !== port.source) return;
        const next = new Map(
          result.versions.map((file) => [file.path, file.version]),
        );
        if (previous) {
          const paths = [
            ...new Set([...previous.keys(), ...next.keys()]),
          ].filter(
            (path) =>
              previous!.has(path) !== next.has(path) ||
              previous!.get(path) !== next.get(path),
          );
          if (paths.length) port.changed(paths);
        }
        previous = next;
      } finally {
        running = false;
      }
    },
  };
}
