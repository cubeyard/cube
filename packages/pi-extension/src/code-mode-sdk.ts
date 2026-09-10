/** Model-facing SDK. Keep this small: future large domains should be
 * documented through lazy API discovery rather than pasted into every
 * prompt. */
export const CODE_MODE_API = `
JavaScript body runs inside an async function; top-level await and return work.
Available API (all methods return promises):
- cube.exec(command, { cwd?, timeoutMs? }) -> { exitCode, output, durationMs }
- cube.fs.readText(path) -> string
- cube.fs.writeText(path, content) -> { ok: true }
- cube.repositories.list() -> repository[]
- cube.repositories.primary() -> repository
- cube.git.syncBase(primaryRepositoryId)
- cube.git.pushBranch(primaryRepositoryId)
- cube.git.pushBase(primaryRepositoryId)
- cube.git.createPr(primaryRepositoryId, { title?, body? })
- cube.services.ensure() -> service[]
- cube.thread.archive() -> { ok: true }
No process, environment, filesystem, network, fetch, require, or imports exist except through cube.
Only the primary repository is writable and publishable. Additional repositories under /repos are read-only references.
Return a JSON-serializable value. Calls are bounded and mutating operations are not transactional.
Await every capability: unawaited failures appear in traces, not necessarily as a failed return.
exec errors include code, timeoutMs/durationMs and bounded partial output where available. timeoutMs starts before wake/exec; cancellation and process-tree shutdown can add latency. Output is combined stdout/stderr, capped at 1 MiB. Redirect larger output to a workspace file.
fs.writeText does not create parent directories; create them explicitly with cube.exec first.
Unknown options are rejected. After ECODE_UNCERTAIN, reconcile outstanding operations before retrying.`.trim();

export const SDK_SOURCE = String.raw`
const __jsonStringify = JSON.stringify;
const __jsonParse = JSON.parse;
const __Error = Error;
const __assign = Object.assign;
const __call = async (operation, args = {}) => {
  const encoded = __jsonStringify(args);
  if (encoded === undefined) throw new TypeError("capability arguments must be JSON-serializable");
  const reply = __jsonParse(await __cubeCall(operation, encoded));
  if (!reply.ok) throw __assign(new __Error(reply.error.message), reply.error);
  return reply.value;
};
const __options = (options, allowed) => {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("capability options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new TypeError("unknown capability option: " + key);
  }
  return options;
};
const cube = Object.freeze({
  exec: (command, options = {}) => __call("exec", { ...__options(options, ["cwd", "timeoutMs"]), command }),
  fs: Object.freeze({
    readText: (path) => __call("fs.readText", { path }),
    writeText: (path, content) => __call("fs.writeText", { path, content }),
  }),
  repositories: Object.freeze({
    list: () => __call("repositories.list"),
    primary: async () => {
      const repositories = await __call("repositories.list");
      const primary = repositories.find((repository) => repository.role === "primary");
      if (!primary) throw new Error("thread has no primary repository");
      return primary;
    },
  }),
  git: Object.freeze({
    syncBase: (repositoryId) => __call("git.syncBase", { repositoryId }),
    pushBranch: (repositoryId) => __call("git.pushBranch", { repositoryId }),
    pushBase: (repositoryId) => __call("git.pushBase", { repositoryId }),
    createPr: (repositoryId, options = {}) => __call("git.createPr", { ...__options(options, ["title", "body"]), repositoryId }),
  }),
  services: Object.freeze({
    ensure: () => __call("services.ensure"),
  }),
  thread: Object.freeze({
    archive: () => __call("thread.archive"),
  }),
});
`;

