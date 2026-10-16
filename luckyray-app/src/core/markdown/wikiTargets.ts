export type WikiReferenceTarget = {
  target: string;
  targetTitle: string;
  subpath: string;
  blockId: string | null;
  display: string;
};

export type RealVaultWikiTargetDocument = {
  relativePath: string;
  fileName?: string | null;
  title?: string | null;
};

export function normalizeVaultRelativePath(value?: string | null) {
  return (value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/").trim();
}

type ResolvedVaultRelativePath = {
  relativePath: string;
  escapedRoot: boolean;
};

function resolveVaultRelativePathWithinRoot(value: string): ResolvedVaultRelativePath {
  const resolved: string[] = [];
  for (const segment of normalizeVaultRelativePath(value).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!resolved.length) return { relativePath: "", escapedRoot: true };
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return { relativePath: resolved.join("/"), escapedRoot: false };
}

function resolveVaultRelativePath(value: string) {
  const resolved = resolveVaultRelativePathWithinRoot(value);
  return resolved.escapedRoot ? "" : resolved.relativePath;
}

export function stripMarkdownExtension(value: string) {
  return value.replace(/\.md$/i, "");
}

export type RealVaultMissingDocumentLocation = {
  parentPath: string;
  fileName: string;
  title: string;
  relativePath: string;
};

export function realVaultMissingDocumentLocation(
  target: string,
  currentRelativePath?: string | null,
  options?: { defaultParent?: "current" | "root" },
): RealVaultMissingDocumentLocation | null {
  const parsed = parseWikiReferenceTarget(target);
  const normalizedTarget = normalizeVaultRelativePath(parsed.targetTitle);
  if (!normalizedTarget) return null;
  const currentPath = normalizeVaultRelativePath(currentRelativePath);
  const currentParent = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/")) : "";
  const resolvesFromCurrentDirectory = normalizedTarget.startsWith(".");
  const resolved = resolveVaultRelativePathWithinRoot(
    resolvesFromCurrentDirectory ? `${currentParent}/${normalizedTarget}` : normalizedTarget,
  );
  if (resolved.escapedRoot || !resolved.relativePath) return null;
  const resolvedTarget = resolved.relativePath;
  const slashIndex = resolvedTarget.lastIndexOf("/");
  const hasExplicitParent = resolvesFromCurrentDirectory || normalizedTarget.includes("/");
  const parentPath = hasExplicitParent
    ? (slashIndex >= 0 ? resolvedTarget.slice(0, slashIndex) : "")
    : options?.defaultParent === "root" ? "" : currentParent;
  const rawName = slashIndex >= 0 ? resolvedTarget.slice(slashIndex + 1) : resolvedTarget;
  const baseName = stripMarkdownExtension(rawName).trim();
  if (!baseName) return null;
  const fileName = `${baseName}.md`;
  return {
    parentPath,
    fileName,
    title: baseName,
    relativePath: parentPath ? `${parentPath}/${fileName}` : fileName,
  };
}

export function normalizeWikiLinkKey(value: string | null | undefined) {
  return (value || "").trim().toLocaleLowerCase();
}

export function parseWikiReferenceTarget(raw: string): WikiReferenceTarget {
  const [targetPart, ...aliasParts] = raw.split("|");
  const target = targetPart.trim();
  const alias = aliasParts.join("|").trim();
  const hashIndex = target.indexOf("#");
  const targetTitle = (hashIndex >= 0 ? target.slice(0, hashIndex) : target).trim();
  const subpath = hashIndex >= 0 ? target.slice(hashIndex + 1).trim() : "";
  const blockId = subpath.startsWith("^") ? subpath.slice(1).trim() || null : null;
  return {
    target,
    targetTitle,
    subpath,
    blockId,
    display: alias || target || raw.trim(),
  };
}

export function realVaultDocumentLookupAliases(document: RealVaultWikiTargetDocument) {
  const relativePath = normalizeVaultRelativePath(document.relativePath);
  const fileName = document.fileName || relativePath.split("/").pop() || relativePath;
  const aliases = new Set<string>();
  [relativePath, stripMarkdownExtension(relativePath), fileName, stripMarkdownExtension(fileName), document.title, stripMarkdownExtension(document.title || "")]
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => aliases.add(item));
  return Array.from(aliases);
}

export function createRealVaultWikiTargetResolver<T extends RealVaultWikiTargetDocument>(documents: T[]) {
  const aliases = new Map<string, T | null>();
  const pathSuffixes = new Map<string, T | null>();
  const addUnique = (lookup: Map<string, T | null>, rawKey: string, document: T) => {
    const key = normalizeWikiLinkKey(rawKey);
    if (!key) return;
    const existing = lookup.get(key);
    if (existing === undefined) lookup.set(key, document);
    else if (existing !== document) lookup.set(key, null);
  };

  for (const document of documents) {
    for (const alias of realVaultDocumentLookupAliases(document)) {
      addUnique(aliases, alias, document);
    }

    const relativePath = normalizeVaultRelativePath(document.relativePath);
    const pathSegments = relativePath.split("/").filter(Boolean);
    for (let index = 0; index < pathSegments.length; index += 1) {
      const suffix = pathSegments.slice(index).join("/");
      addUnique(pathSuffixes, suffix, document);
      addUnique(pathSuffixes, stripMarkdownExtension(suffix), document);
    }
  }

  return (rawTarget: string, sourceRelativePath?: string | null): T | null => {
    const parsed = parseWikiReferenceTarget(rawTarget);
    const normalizedTarget = normalizeVaultRelativePath(parsed.targetTitle || rawTarget);
    if (!normalizedTarget) return null;
    const exactKeys = [
      normalizedTarget,
      stripMarkdownExtension(normalizedTarget),
      /\.md$/i.test(normalizedTarget) ? normalizedTarget : `${normalizedTarget}.md`,
    ];
    for (const key of exactKeys) {
      const document = aliases.get(normalizeWikiLinkKey(key));
      if (document) return document;
    }

    if (sourceRelativePath) {
      const sourcePath = normalizeVaultRelativePath(sourceRelativePath);
      const sourceDirectory = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
      const relativeTarget = resolveVaultRelativePath(`${sourceDirectory}/${normalizedTarget}`);
      if (relativeTarget) {
        const relativeKeys = [
          relativeTarget,
          stripMarkdownExtension(relativeTarget),
          /\.md$/i.test(relativeTarget) ? relativeTarget : `${relativeTarget}.md`,
        ];
        for (const key of relativeKeys) {
          const document = aliases.get(normalizeWikiLinkKey(key));
          if (document) return document;
        }
      }
    }

    for (const key of exactKeys) {
      const document = pathSuffixes.get(normalizeWikiLinkKey(key));
      if (document) return document;
    }
    return null;
  };
}
