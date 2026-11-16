import { useEffect, useRef, useState, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "[tabindex]",
  "[contenteditable='true']",
].join(", ");

/**
 * Whether an element can actually receive keyboard focus right
 * now. A candidate selector match is not enough: the element
 * must not be disabled (directly or through a disabled
 * fieldset), must not sit inside inert or aria-hidden subtrees,
 * and must not be hidden — by the hidden attribute, an
 * input[type=hidden], or computed style. Elements with a
 * negative tabindex are programmatically focusable but not
 * tabbable, so they are excluded from trap cycling.
 */
/** True when the element or any ancestor is inert — checked via
 * the IDL property as well as the attribute, since frameworks
 * commonly set the property only. */
export function insideInert(element: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current !== null) {
    if (current.hasAttribute("inert")) return true;
    if ((current as HTMLElement & { inert?: boolean }).inert === true) return true;
    current = current.parentElement;
  }
  return false;
}

export function isTabbableCandidate(element: HTMLElement): boolean {
  if (element.tabIndex < 0) return false;
  if (element.hasAttribute("disabled")) return false;
  if ((element as HTMLButtonElement).disabled === true) return false;
  if (element.closest("fieldset[disabled]") !== null) return false;
  if (insideInert(element)) return false;
  if (element.closest("[aria-hidden='true']") !== null) return false;
  if (element.hasAttribute("hidden")) return false;
  if (element instanceof HTMLInputElement && element.type === "hidden") return false;
  try {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
  } catch {
    // Computed style unavailable: keep the candidate rather
    // than risk stranding focus.
  }
  return true;
}

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter(isTabbableCandidate);
}

/** Live media-query state; false when matchMedia is unavailable. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * Modal focus contract for an overlay surface (mobile sidebar,
 * mobile drawer): while `active`, Tab/Shift+Tab cycle inside the
 * container, focus starts on the first tabbable element, and on
 * deactivation focus returns to whatever held it before. When
 * `active` is false the surface is untouched — the same element
 * doubles as a static desktop region.
 */
export function useOverlayModal(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
): void {
  const restoreRef = useRef<Element | null>(null);
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (container === null) return;
    restoreRef.current = document.activeElement;
    const first = focusableElements(container)[0];
    if (first !== undefined) first.focus();
    else {
      container.tabIndex = -1;
      container.focus();
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusables = focusableElements(container);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const firstElement = focusables[0]!;
      const lastElement = focusables[focusables.length - 1]!;
      const current = document.activeElement;
      if (event.shiftKey && (current === firstElement || !container.contains(current))) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && (current === lastElement || !container.contains(current))) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      const restore = restoreRef.current;
      restoreRef.current = null;
      if (restore instanceof HTMLElement && restore.isConnected) restore.focus();
    };
  }, [active, containerRef]);
}
