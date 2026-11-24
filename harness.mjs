// Runs the real page script in Node, with a stub DOM.
//
//   import { boot, flush } from "./harness.mjs";
//   const page = boot();
//   page.el("bump").click();
//
// The point is that verify.mjs tests the code in index.html, not a copy of it.
// Extend the stub when your UI uses more of the DOM than this covers.
import { readFileSync } from "node:fs";

export function boot({ file = "index.html" } = {}) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const match = source.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error(file + " has no <script> block");

  const els = new Map();

  const make = id => {
    const listeners = Object.create(null);
    const el = {
      id,
      value: "",
      className: "",
      textContent: "",
      innerHTML: "",
      hidden: false,
      disabled: false,
      style: {},
      children: [],
      addEventListener(type, fn) {
        (listeners[type] ||= []).push(fn);
      },
      dispatch(type, event = { type }) {
        for (const fn of listeners[type] || []) fn(event);
      },
      click() {
        el.dispatch("click");
      },
      querySelector() {
        return make(id + " > *");
      },
      appendChild(child) {
        el.children.push(child);
        return child;
      },
      insertAdjacentHTML() {},
      setAttribute() {}
    };
    return el;
  };

  const el = id => {
    if (!els.has(id)) els.set(id, make(id));
    return els.get(id);
  };

  const storage = new Map();

  globalThis.document = {
    getElementById: el,
    createElement: () => make("new"),
    title: ""
  };
  globalThis.location = { search: "" };
  globalThis.localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k)
  };
  globalThis.window = globalThis;
  globalThis.confirm = () => false;
  globalThis.scrollTo = () => {};
  globalThis.addEventListener = () => {};

  new Function(match[1])();

  return { el, els, script: match[1], globals: globalThis };
}

// Lets a page's async boot finish before assertions run.
export const flush = () => new Promise(resolve => setTimeout(resolve, 0));
