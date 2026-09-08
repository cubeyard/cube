/**
 * pi tool operations backed by a CubeFs — separated from the extension
 * factory so the offline test can drive pi's real tool implementations
 * against a scripted/local guest.
 */
import type {
  EditOperations,
  FindOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";

import type { CubeFs } from "./cube-fs.ts";
import { toGuestPath } from "./paths.ts";

export interface GuestOperations {
  guest: (p: string) => string;
  readOps: ReadOperations;
  writeOps: WriteOperations;
  editOps: EditOperations;
  lsOps: LsOperations;
  findOps: FindOperations;
}

export function createGuestOperations(
  cubeFs: CubeFs,
  hostWorkspace: string,
  guestWorkspace: string,
): GuestOperations {
  const guest = (p: string) => toGuestPath(hostWorkspace, guestWorkspace, p);

  const readOps: ReadOperations = {
    readFile: (p) => cubeFs.readFile(guest(p)),
    access: (p) => cubeFs.access(guest(p)),
    // Always null: never let hostile cube bytes named .png/.jpg reach pi's
    // host-side image decoder/resizer. Images render through cubed's own
    // workspace-files route (CSP-sandboxed), which is the product path.
    detectImageMimeType: async () => null,
  };
  const writeOps: WriteOperations = {
    writeFile: (p, content) => cubeFs.writeFile(guest(p), content),
    mkdir: (dir) => cubeFs.mkdir(guest(dir)),
  };
  const editOps: EditOperations = {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: (p) => cubeFs.access(guest(p), { write: true }),
  };
  const lsOps: LsOperations = {
    exists: async (p) => (await cubeFs.statOrNull(guest(p))) !== null,
    stat: async (p) => {
      const stat = await cubeFs.statOrNull(guest(p));
      if (!stat) throw new Error(`no such path: ${p}`);
      return { isDirectory: () => stat.isDir };
    },
    readdir: (p) => cubeFs.readdir(guest(p)),
  };
  const findOps: FindOperations = {
    exists: async (p) => (await cubeFs.statOrNull(guest(p))) !== null,
    glob: (pattern, cwd, options) => cubeFs.glob(pattern, guest(cwd), options.limit),
  };

  return { guest, readOps, writeOps, editOps, lsOps, findOps };
}
