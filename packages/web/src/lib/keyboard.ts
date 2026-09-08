/**
 * iOS Safari does not shrink the layout viewport when the on-screen
 * keyboard opens — it pans the page instead, leaving a keyboard-sized
 * void of body background under a 100dvh app. While a keyboard is
 * eating space, pin #app's height to the visual viewport and hold the
 * window at 0, so the composer docks onto the keyboard like a native
 * input bar and the transcript shrinks above it.
 *
 * Android Chrome honors `interactive-widget=resizes-content` in the
 * viewport meta and never takes this path. The scale guard keeps
 * desktop pinch-zoom from shrinking the app.
 */
export function pinToVisualViewport(app: HTMLElement): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const sync = () => {
    const keyboardOpen = vv.scale === 1 && vv.height < window.innerHeight - 50;
    app.style.height = keyboardOpen ? `${vv.height}px` : "";
    if (keyboardOpen && (window.scrollY !== 0 || vv.offsetTop !== 0)) window.scrollTo(0, 0);
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
}
