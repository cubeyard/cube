/**
 * Local list key. crypto.randomUUID exists only in SECURE contexts — and
 * the product is served over plain http on the Tailnet by design
 * (http://<node>:7777), where it is undefined and would throw at render.
 * getRandomValues is available everywhere; these keys are list identity,
 * not cryptography.
 */
export function uid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
