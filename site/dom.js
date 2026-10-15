const FRAME = {
  tile: "tile",
  controls: "controls",
  body: "body",
  /** The attribute of the drag handle: the layout drags a window by the element that has it. */
  drag: "data-window-drag"
};
function frameControls(win) {
  const controls = [];
  if (win.modes.length > 1) {
    controls.push({
      id: "float",
      label: "float or tile",
      text: "⧉",
      call: win.mode === "float" ? "layout.tile" : "layout.float",
      run: () => win.mode === "float" ? win.requestTile() : win.requestFloat()
    });
  }
  controls.push({ id: "close", label: "close", text: "×", call: "layout.close", run: () => win.close() });
  return controls;
}
function drawControls(host, win) {
  const buttons = /* @__PURE__ */ new Map();
  const draw = () => {
    const controls = frameControls(win);
    for (const [id, { button }] of buttons) {
      if (!controls.some((control) => control.id === id)) {
        button.remove();
        buttons.delete(id);
      }
    }
    let before = null;
    for (const control of [...controls].reverse()) {
      let entry = buttons.get(control.id);
      if (!entry) {
        const button2 = document.createElement("button");
        button2.type = "button";
        button2.setAttribute(`data-${control.id}`, "");
        const created = { button: button2, control };
        button2.addEventListener("click", () => created.control.run());
        buttons.set(control.id, entry = created);
      }
      entry.control = control;
      const { button } = entry;
      if (button.getAttribute("aria-label") !== control.label) button.setAttribute("aria-label", control.label);
      if (button.dataset.call !== control.call) button.dataset.call = control.call;
      if (button.textContent !== control.text) button.textContent = control.text;
      if (button.parentElement !== host || button.nextElementSibling !== before) host.insertBefore(button, before);
      before = button;
    }
  };
  draw();
  const unsubscribe = win.subscribe(draw, ["mode", "modes"]);
  return () => {
    unsubscribe();
    for (const { button } of buttons.values()) button.remove();
    buttons.clear();
  };
}
function frame(win, options = {}) {
  const tile = element("section", options.className ? `${FRAME.tile} ${options.className}` : FRAME.tile);
  const header = element("header");
  header.setAttribute(FRAME.drag, "");
  const controls = element("div", FRAME.controls);
  const body = element("div", FRAME.body);
  tile.append(header, controls, body);
  const undo = [];
  if (options.controls !== false) undo.push(drawControls(controls, win));
  if (options.title !== void 0) {
    if (options.title !== null) header.textContent = options.title;
  } else {
    const title = () => {
      if (header.textContent !== win.title) header.textContent = win.title;
    };
    title();
    undo.push(win.subscribe(title, ["title"]));
  }
  let disposed = false;
  return {
    tile,
    header,
    controls,
    body,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const fn of undo.reverse()) fn();
      tile.remove();
    }
  };
}
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== void 0) el.textContent = text;
  return el;
}
export {
  FRAME,
  drawControls,
  element,
  frame,
  frameControls
};
//# sourceMappingURL=dom.js.map
