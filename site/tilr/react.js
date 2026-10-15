import { jsx } from "react/jsx-runtime";
import { createContext, useContext, useEffect, useMemo, useReducer, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { sameSelection } from "../selection.js";
const WindowScope = createContext(null);
function mount(host, element) {
  const root = createRoot(host);
  root.render(element);
  return () => {
    queueMicrotask(() => root.unmount());
  };
}
function useWindow(fields) {
  const scope = useContext(WindowScope);
  if (!scope) throw new Error("useWindow(): not inside a window (windowType() or windowRoot())");
  const [, bump] = useReducer((n) => n + 1, 0);
  const key = fields?.join(",");
  useEffect(() => key === void 0 ? scope.win.subscribe(bump) : void 0, [scope.win, key]);
  const source = useMemo(() => {
    const fields2 = key?.split(",").filter(Boolean);
    const read = () => fields2?.map((field) => scope.win[field]) ?? [];
    let value = read();
    return {
      subscribe: (notify) => fields2 ? scope.win.subscribe(notify, fields2) : () => {
      },
      getSnapshot: () => {
        const next = read();
        if (!sameSelection(value, next)) value = next;
        return value;
      }
    };
  }, [scope.win, key]);
  useSyncExternalStore(source.subscribe, source.getSnapshot);
  return scope.win;
}
function useWindowField(field) {
  const scope = useContext(WindowScope);
  if (!scope) throw new Error("useWindowField(): not inside a window");
  const source = useMemo(() => {
    const win = scope.win;
    let value = win[field];
    return {
      subscribe: (notify) => win.subscribe(notify, [field]),
      getSnapshot: () => {
        const next = win[field];
        if (!sameSelection(value, next)) value = next;
        return value;
      }
    };
  }, [scope.win, field]);
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}
function useCtx() {
  const scope = useContext(WindowScope);
  if (!scope) throw new Error("useCtx(): not inside a window (windowType() or windowRoot())");
  return scope.ctx;
}
function windowRoot(ctx, win, children) {
  return /* @__PURE__ */ jsx(WindowScope.Provider, { value: { ctx, win }, children });
}
function windowType(options) {
  const { id, component: Component, author, tags, version, api, requires, ...type } = options;
  return {
    name: id,
    author,
    tags,
    version,
    api,
    requires,
    inject: ["windows"],
    apply(ctx) {
      ctx.windows.register(id, {
        ...type,
        mount(host, win) {
          return mount(host, windowRoot(ctx, win, /* @__PURE__ */ jsx(Component, { win })));
        }
      });
    }
  };
}
export {
  mount,
  useCtx,
  useWindow,
  useWindowField,
  windowRoot,
  windowType
};
//# sourceMappingURL=react.js.map
