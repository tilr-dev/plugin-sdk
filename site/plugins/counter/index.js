import { Service } from "cordis";
const STEP = 1;
class Counter extends Service {
  static provide = "counter";
  static inject = ["ui"];
  static author = "dan";
  static tags = ["demo"];
  // What `requires: { counter: '^0.1.0' }` in another plugin is checked against. In-tree, so the
  // core's version (build.mjs defines it); a plugin repo would define its own package.json's.
  static version = "0.1.14";
  constructor(ctx) {
    super(ctx, Counter.provide);
    this.state = { value: 0 };
    const body = ctx.ui.tile({ title: "counter" });
    const value = document.createElement("div");
    value.className = "big";
    const button = document.createElement("button");
    button.textContent = `+${STEP}`;
    button.onclick = () => this.add(STEP);
    body.append(value, button);
    this.render = () => {
      value.textContent = String(this.state.value);
    };
    this.render();
  }
  get value() {
    return this.state.value;
  }
  add(n = STEP) {
    this.state.value += n;
    this.render();
    this.ctx.emit("counter/change", this.state.value);
  }
}
var counter_default = Counter;
export {
  counter_default as default
};
//# sourceMappingURL=index.js.map
