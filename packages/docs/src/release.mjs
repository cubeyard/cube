export const repository = "https://github.com/cubeyard/cube";
export const docsRef = process.env.CUBE_DOCS_REF?.trim() || "main";
export const isRelease = /^v\d+\.\d+\.\d+$/.test(docsRef);
