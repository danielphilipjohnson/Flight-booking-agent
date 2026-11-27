import { JSDOM } from "jsdom";

/**
 * Minimal browser globals so @testing-library/react's renderHook can mount
 * hooks under plain `node --test` (no vitest/jsdom test environment needed).
 * Imported for side effects before the testing-library imports in
 * useChat.test.ts.
 */
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

const { window } = dom;

function setGlobal(key: string, value: unknown): void {
  try {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  } catch {
    // Node already provides a compatible global (e.g. navigator) — keep it.
  }
}

setGlobal("window", window);
setGlobal("document", window.document);
setGlobal("navigator", window.navigator);
setGlobal("HTMLElement", window.HTMLElement);
setGlobal("Element", window.Element);
setGlobal("Node", window.Node);
setGlobal("MutationObserver", window.MutationObserver);
setGlobal("getComputedStyle", window.getComputedStyle.bind(window));
setGlobal("requestAnimationFrame", window.requestAnimationFrame.bind(window));
setGlobal("cancelAnimationFrame", window.cancelAnimationFrame.bind(window));
setGlobal("localStorage", window.localStorage);
setGlobal("self", window);
setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
