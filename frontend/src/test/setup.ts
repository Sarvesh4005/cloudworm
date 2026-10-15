import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";

// jsdom only implements crypto.getRandomValues; use Node's full WebCrypto for tests.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

// Vitest globals are off, so Testing Library can't register its own auto-cleanup.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
afterEach(() => cleanup());
