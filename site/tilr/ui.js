import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { useWindow, useWindowField } from "tilr/react";
import { FRAME, frameControls } from "../dom.js";
import { element, frame, frameControls as frameControls2, FRAME as FRAME2 } from "../dom.js";
function Frame({ title, controls = true, children }) {
  const win = useWindow(["mode", "modes"]);
  const drag = { [FRAME.drag]: "" };
  return /* @__PURE__ */ jsxs("section", { className: FRAME.tile, children: [
    /* @__PURE__ */ jsx("header", { ...drag, children: title ?? /* @__PURE__ */ jsx(WindowTitle, {}) }),
    controls && /* @__PURE__ */ jsx("div", { className: FRAME.controls, children: frameControls(win).map((control) => /* @__PURE__ */ jsx("button", { type: "button", ...{ [`data-${control.id}`]: "" }, "aria-label": control.label, "data-call": control.call, onClick: () => control.run(), children: control.text }, control.id)) }),
    /* @__PURE__ */ jsx("div", { className: FRAME.body, children })
  ] });
}
function WindowTitle() {
  const title = useWindowField("title");
  return /* @__PURE__ */ jsx(Fragment, { children: title });
}
export {
  FRAME2 as FRAME,
  Frame,
  element,
  frame,
  frameControls2 as frameControls
};
//# sourceMappingURL=ui.js.map
