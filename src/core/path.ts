// Path patterns: `/orders/:id`, `/files/*`. Segment-based (no regex) so user patterns can't cause ReDoS.

type Seg = { t: "lit"; v: string } | { t: "param"; name: string } | { t: "wild" };

export interface CompiledPath {
  segments: Seg[];
  literals: number;
  params: number;
  wildcard: boolean;
}

const split = (p: string) => p.split("/").filter(Boolean);

export function compilePath(pattern: string): CompiledPath {
  const segments: Seg[] = split(pattern).map((s) => {
    if (s === "*") return { t: "wild" as const };
    if (s.startsWith(":") && s.length > 1) return { t: "param" as const, name: s.slice(1) };
    return { t: "lit" as const, v: s };
  });
  return {
    segments,
    literals: segments.filter((s) => s.t === "lit").length,
    params: segments.filter((s) => s.t === "param").length,
    wildcard: segments.some((s) => s.t === "wild"),
  };
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // malformed escape: keep it raw rather than failing the request
  }
}

/** Returns the extracted params (`*` holds the wildcard remainder) or null when the path doesn't match. */
export function matchPath(compiled: CompiledPath, path: string): Record<string, string> | null {
  const parts = split(path);
  const params: Record<string, string> = {};
  const segs = compiled.segments;

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.t === "wild") {
      params["*"] = parts.slice(i).map(decode).join("/");
      return params;
    }
    if (i >= parts.length) return null;
    if (seg.t === "lit") {
      if (decode(parts[i]) !== seg.v) return null;
    } else {
      params[seg.name] = decode(parts[i]);
    }
  }
  return parts.length === segs.length ? params : null;
}

/** Sort comparator: most specific pattern first (more literals, no wildcard, fewer params). */
export function bySpecificity(a: CompiledPath, b: CompiledPath): number {
  if (a.literals !== b.literals) return b.literals - a.literals;
  if (a.wildcard !== b.wildcard) return a.wildcard ? 1 : -1;
  return a.params - b.params;
}
