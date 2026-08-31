import { AsyncLocalStorage } from "node:async_hooks";

// Request-scoped facts the renderers need but that would otherwise have to be
// threaded through every route. `enterWith` in an onRequest hook keeps the store
// attached for the rest of that request's async context.
const storage = new AsyncLocalStorage();

export function beginRequest(context) {
  storage.enterWith(context);
}

export function isViewerRequest() {
  return Boolean(storage.getStore()?.viewer);
}
