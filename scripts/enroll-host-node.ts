/** @deprecated Use enroll-runner.ts. This wrapper preserves existing operator
 * automation and delegates without changing arguments or persisted identity. */
console.error("cube: enroll-host-node.ts is deprecated; use enroll-runner.ts");
await import("./enroll-runner.ts");
