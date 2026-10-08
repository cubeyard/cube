/** A phone, or a touch screen turned on its side: the chrome folds behind
 * keys so the conversation keeps the screen. app.css repeats this query. */
export const COMPACT_MEDIA = "(max-width: 40rem), (pointer: coarse) and (max-height: 30rem)";

/** Under this much room a keyboard leaves only the composer and a few lines. */
const TIGHT_PX = 220;
/** A keyboard takes at least this much; browser bars that come and go take less. */
const KEYBOARD_PX = 120;

/** Fields that raise a keyboard. Date and time inputs open a picker on
 * Android, which leaves the viewport whole, so they never read as typing. */
const EDITABLE = "textarea, [contenteditable]:not([contenteditable=false]), input:not([type=checkbox], [type=radio], [type=button], [type=submit], [type=reset], [type=file], [type=range], [type=color], [type=image])";

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
 *
 * Either way the root carries `data-keyboard` while a text field has
 * focus and the visual viewport is well short of the tallest it has been
 * at this width ("tight" when little is left, as on a phone on its side),
 * so app.css can fold the chrome for the conversation while typing.
 */
export function pinToVisualViewport(app: HTMLElement): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  // A narrow desktop window shortened by hand is not a keyboard.
  const touch = window.matchMedia("(pointer: coarse)");
  // A rotation is a new width, and a new tallest.
  const tallest = new Map<number, number>();
  // Turned with the keyboard up (Android shrinks innerHeight too), a new
  // width has no measure without the keyboard: typing carries over until
  // the field is left or the room grows by a keyboard.
  let carried: { width: number; height: number } | null = null;
  const sync = () => {
    const unzoomed = Math.abs(vv.scale - 1) < 0.01;
    const keyboardOpen = unzoomed && vv.height < window.innerHeight - 50;
    app.style.height = keyboardOpen ? `${vv.height}px` : "";
    if (keyboardOpen && (window.scrollY !== 0 || vv.offsetTop !== 0)) window.scrollTo(0, 0);

    const editing = touch.matches && !!document.activeElement?.matches(EDITABLE);
    // Zoomed in, the viewport's size says nothing; leaving the field still ends it.
    if (!unzoomed) {
      if (!editing) delete root.dataset.keyboard;
      return;
    }
    const width = Math.round(vv.width);
    const height = Math.round(vv.height);
    if (carried && (carried.width !== width || !editing || height >= carried.height + KEYBOARD_PX)) {
      // what this width shows once the keyboard is down is its measure
      if (carried.width === width) tallest.set(width, Math.max(height, window.innerHeight));
      carried = null;
    }
    if (!carried && editing && root.dataset.keyboard && !tallest.has(width)) carried = { width, height };
    // iOS keeps the layout viewport whole under its keyboard: innerHeight
    // is the room without one even before this width has been seen open.
    const top = Math.max(tallest.get(width) ?? 0, height, window.innerHeight);
    if (!carried) tallest.set(width, top);
    const typing = !!carried || (editing && height < top - KEYBOARD_PX);
    const state = !typing ? null : height < TIGHT_PX ? "tight" : "open";
    if (state) root.dataset.keyboard = state;
    else delete root.dataset.keyboard;
  };
  sync();
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  window.addEventListener("resize", sync);
  touch.addEventListener("change", sync);
  // Focus moves before the keyboard does; leaving the field ends it at once.
  document.addEventListener("focusin", sync);
  document.addEventListener("focusout", () => queueMicrotask(sync));
}
