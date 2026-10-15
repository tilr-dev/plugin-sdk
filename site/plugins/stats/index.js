import { definePlugin } from "tilr";
var stats_default = definePlugin({
  name: "stats",
  author: "dan",
  tags: ["demo"],
  version: "0.1.14",
  inject: ["ui", "counter"],
  apply(ctx) {
    const body = ctx.ui.tile({ title: "stats" });
    const line = document.createElement("div");
    const since = document.createElement("div");
    since.className = "muted";
    since.textContent = `mounted ${(/* @__PURE__ */ new Date()).toLocaleTimeString("en-GB")}`;
    body.append(line, since);
    let clicks = 0;
    const render = () => {
      line.innerHTML = `counter is <span class="accent"></span>, <b></b> clicks since mount`;
      line.querySelector("span").textContent = String(ctx.counter.value);
      line.querySelector("b").textContent = String(clicks);
    };
    ctx.on("counter/change", () => {
      clicks++;
      render();
    });
    render();
  }
});
export {
  stats_default as default
};
//# sourceMappingURL=index.js.map
