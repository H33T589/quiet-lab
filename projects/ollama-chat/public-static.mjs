import { realpathSync } from "node:fs";
import path from "node:path";

const publicDirCanonicalCache = new Map();

function getPublicDirCanonical(publicDirAbs) {
  const key = path.resolve(publicDirAbs);

  if (publicDirCanonicalCache.has(key)) {
    return publicDirCanonicalCache.get(key);
  }

  let canonical;

  try {
    canonical = realpathSync(key);
  } catch {
    canonical = key;
  }

  publicDirCanonicalCache.set(key, canonical);
  return canonical;
}

/**
 * Map a URL pathname to a safe filesystem path under publicDirAbs.
 * Blocks directory traversal and symlink escapes outside the public folder.
 */
export function resolvePublicFilePath(publicDirAbs, requestPathname) {
  const pathname = requestPathname || "/";
  const relative =
    pathname === "/" || pathname === "" ? "index.html" : pathname.startsWith("/") ? pathname.slice(1) : pathname;

  if (!relative || relative.includes("\0")) {
    return null;
  }

  const publicDirCanonical = getPublicDirCanonical(publicDirAbs);
  const candidate = path.resolve(publicDirAbs, relative);

  let canonicalFile;

  try {
    canonicalFile = realpathSync(candidate);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return null;
    }

    const relativeToPublic = path.relative(publicDirCanonical, path.normalize(candidate));

    if (relativeToPublic.startsWith("..") || path.isAbsolute(relativeToPublic)) {
      return null;
    }

    return candidate;
  }

  const relativeToPublic = path.relative(publicDirCanonical, canonicalFile);

  if (relativeToPublic.startsWith("..") || path.isAbsolute(relativeToPublic)) {
    return null;
  }

  return candidate;
}
