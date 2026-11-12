import type { DiffFile } from '@relay/shared';

/**
 * The changed files as a folder tree. Pure. Folders come before files at each level, both in path order;
 * a folder holding nothing but one sub-folder is merged into it (`src/auth/`), so deep paths do not waste rows.
 */
export interface DirNode {
  /** Display name, may span merged levels (`src/auth`). */
  name: string;
  /** Full path of the folder, no trailing slash ('' = root). */
  path: string;
  dirs: DirNode[];
  files: DiffFile[];
}

const segs = (p: string) => p.split('/');

/** Folder-first path order: `a/b/c.ts` < `a/d.ts` < `z.ts`. */
export function compareTreePaths(a: string, b: string): number {
  const x = segs(a);
  const y = segs(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const lastX = i === x.length - 1;
    const lastY = i === y.length - 1;
    if (lastX !== lastY) return lastX ? 1 : -1; // a folder before a file at the same level
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return x.length - y.length;
}

export const sortForTree = (files: readonly DiffFile[]): DiffFile[] =>
  [...files].sort((a, b) => compareTreePaths(a.path, b.path));

export function buildTree(files: readonly DiffFile[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: [], files: [] };
  for (const f of sortForTree(files)) {
    const parts = segs(f.path);
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let next = node.dirs.find((d) => d.path === path);
      if (!next) {
        next = { name: part, path, dirs: [], files: [] };
        node.dirs.push(next);
      }
      node = next;
    }
    node.files.push(f);
  }
  const merge = (n: DirNode): DirNode => {
    let cur = n;
    while (cur.files.length === 0 && cur.dirs.length === 1) {
      const only = cur.dirs[0]!;
      cur = { ...only, name: `${cur.name}/${only.name}` };
    }
    return { ...cur, dirs: cur.dirs.map(merge) };
  };
  return { ...root, dirs: root.dirs.map(merge) };
}
