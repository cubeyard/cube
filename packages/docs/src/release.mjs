// The release this build documents. The docs workflow sets CUBE_DOCS_REF to
// the published tag; a local or pull-request build documents `main`.
export const repository = "https://github.com/cubeyard/cube";
export const docsRef = process.env.CUBE_DOCS_REF?.trim() || "main";
export const isRelease = /^v\d+\.\d+\.\d+$/.test(docsRef);
