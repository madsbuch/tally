// Navigation in a real browser: the history stack, the back button, sheets —
// the real lib/navigation.ts and lib/sheetHistory.ts under a stub app
// (nav-harness.tsx), driven with Playwright. `bun run test:nav`.
const path = require("node:path");
const { chromium } = require("playwright");

let BASE = "";
const M = "meal_01h455vb4pex5vsknk084sn02q";
const C1 = "chat_01h455vb4pex5vsknk084sn02q";
const C2 = "chat_01h455vb4pex5vsknk084sn02r";

let failures = 0;
async function scenario(browser, name, start, steps) {
  const page = await browser.newPage();
  const at = async () =>
    page.evaluate(() => ({
      path: document.getElementById("path")?.textContent,
      tab: document.getElementById("tab")?.textContent,
      label: document.getElementById("label")?.textContent,
      sheet: document.getElementById("sheet")?.textContent,
      depth: (window.history.state && window.history.state.idx) || 0,
    }));
  const settle = () => page.waitForTimeout(250);
  const t = {
    go: async (to, opts) => { await page.evaluate(([to, opts]) => window.nav.go(to, opts), [to, opts]); await settle(); },
    up: async () => { await page.evaluate(() => window.nav.up()); await settle(); },
    back: async () => { await page.evaluate(() => window.history.back()); await settle(); },
    sheet: async () => { await page.evaluate(() => window.nav.openSheet()); await settle(); },
    reload: async () => { await page.reload(); await page.waitForSelector("#path"); },
    expect: async (want, what) => {
      const got = await at();
      const bad = Object.entries(want).filter(([k, v]) => got[k] !== v);
      if (bad.length) {
        failures++;
        console.log(`  ✗ ${name}: ${what}\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`);
      }
    },
  };
  await page.goto(BASE + start);
  await page.waitForSelector("#path");
  await steps(t);
  await page.close();
  console.log(`${failures ? "…" : "✓"} ${name}`);
}

(async () => {
  const { createServer } = await import("vite");
  const server = await createServer({ configFile: path.join(__dirname, "vite.config.ts"), logLevel: "error" });
  await server.listen();
  BASE = `http://localhost:${server.config.server.port}`;
  const browser = await chromium.launch();

  await scenario(browser, "a meal opened from a chat goes back to the chat", "/assistant", async (t) => {
    await t.go(`/assistant/${C1}`);
    await t.go(`/entry/meal/${M}`);
    await t.expect({ path: `/entry/meal/${M}`, tab: "/assistant", label: "Chat", depth: 2 }, "meal is on the Coach's stack");
    await t.back();
    await t.expect({ path: `/assistant/${C1}`, tab: "/assistant", depth: 1 }, "hardware back → the chat");
    await t.go(`/entry/meal/${M}`);
    await t.up();
    await t.expect({ path: `/assistant/${C1}`, tab: "/assistant", depth: 1 }, "‹ Back → the chat");
    await t.up();
    await t.expect({ path: "/assistant", tab: "/assistant", depth: 0 }, "‹ Back from the chat → the list");
  });

  await scenario(browser, "a link back to something on the stack pops to it", "/assistant", async (t) => {
    await t.go(`/assistant/${C1}`);
    await t.go(`/entry/meal/${M}`);
    await t.go(`/assistant/${C1}`);
    await t.expect({ path: `/assistant/${C1}`, depth: 1 }, "no second copy of the chat");
    await t.back();
    await t.expect({ path: "/assistant", depth: 0 }, "back → the list, not the meal");
  });

  await scenario(browser, "list → detail → back to the list", "/assistant", async (t) => {
    await t.go("/assistant/manuals");
    await t.go("/assistant/manuals/manual_x");
    await t.expect({ label: "usual", depth: 2 }, "the usual label when back goes to the list");
    await t.up();
    await t.expect({ path: "/assistant/manuals", depth: 1 }, "‹ Back → the manuals");
    await t.up();
    await t.expect({ path: "/assistant", depth: 0 }, "‹ Back → the Coach");
  });

  await scenario(browser, "a deleted page isn't gone back to", "/assistant", async (t) => {
    await t.go("/assistant/manuals");
    await t.go("/assistant/manuals/manual_x");
    await t.go("/assistant/manuals", { replace: true });
    await t.expect({ path: "/assistant/manuals", depth: 1 }, "popped to the list");
    await t.go("/assistant/experiments/experiment_y");
    await t.go("/assistant/experiments", { replace: true });
    await t.expect({ path: "/assistant/experiments", depth: 2 }, "replaced: the deleted experiment is gone");
    await t.back();
    await t.expect({ path: "/assistant/manuals", depth: 1 }, "back skips the deleted page");
  });

  await scenario(browser, "a detail page opened by its URL goes up to its list", "/assistant/manuals/manual_x", async (t) => {
    await t.expect({ tab: "/assistant", label: "usual", depth: 0 }, "deep URL");
    await t.up();
    await t.expect({ path: "/assistant/manuals", depth: 0 }, "‹ Back → the list, in its place");
    await t.up();
    await t.expect({ path: "/assistant", depth: 0 }, "‹ Back → the Coach");
  });

  await scenario(browser, "another tab's page stays on the stack you came from", "/body", async (t) => {
    await t.go("/assistant/library");
    await t.expect({ tab: "/body", label: "Body", depth: 1 }, "library from Body lights Body");
    await t.back();
    await t.expect({ path: "/body", tab: "/body", depth: 0 }, "back → Body");
    await t.go("/assistant/experiments/experiment_y");
    await t.go("/assistant/manuals/manual_x");
    await t.expect({ tab: "/body", label: "Experiment", depth: 2 }, "two deep from Body");
    await t.up();
    await t.up();
    await t.expect({ path: "/body", depth: 0 }, "‹ Back twice → Body");
  });

  await scenario(browser, "the tab bar starts a tab afresh", "/assistant", async (t) => {
    await t.go(`/assistant/${C1}`);
    await t.go(`/entry/meal/${M}`);
    await t.go("/");
    await t.expect({ path: "/", tab: "/", depth: 0 }, "Diary, nothing beneath");
    await t.go(`/assistant/${C1}`, { jump: true });
    await t.expect({ path: `/assistant/${C1}`, tab: "/assistant", depth: 1 }, "Coach tab back to the open chat");
    await t.back();
    await t.expect({ path: "/assistant", depth: 0 }, "with the list beneath");
  });

  await scenario(browser, "a notification opens its chat over the Coach list", "/body", async (t) => {
    await t.go("/assistant/library");
    await t.go(`/assistant/${C2}`, { jump: true });
    await t.expect({ path: `/assistant/${C2}`, tab: "/assistant", label: "usual", depth: 1 }, "chat on the Coach's stack");
    await t.back();
    await t.expect({ path: "/assistant", tab: "/assistant", depth: 0 }, "back → the list");
  });

  await scenario(browser, "sheets close before a page is pushed, and back skips them", "/assistant", async (t) => {
    await t.go(`/assistant/${C1}`);
    await t.sheet();
    await t.expect({ sheet: "open", depth: 1 }, "sheet open on the chat");
    await t.go(`/entry/meal/${M}`);
    await t.expect({ path: `/entry/meal/${M}`, sheet: "closed", depth: 2 }, "meal pushed, sheet closed");
    await t.back();
    await t.expect({ path: `/assistant/${C1}`, sheet: "closed", depth: 1 }, "back → the chat, not the sheet");
    await t.sheet();
    await t.back();
    await t.expect({ path: `/assistant/${C1}`, sheet: "closed" }, "hardware back closes a sheet first");
    await t.sheet();
    await t.up();
    await t.expect({ path: "/assistant", sheet: "closed", depth: 0 }, "‹ Back with a sheet open → the list");
  });

  await scenario(browser, "the stack survives a reload", "/assistant", async (t) => {
    await t.go(`/assistant/${C1}`);
    await t.go(`/entry/meal/${M}`);
    await t.reload();
    await t.expect({ path: `/entry/meal/${M}`, tab: "/assistant", label: "Chat" }, "still on the Coach's stack");
    await t.back();
    await t.expect({ path: `/assistant/${C1}`, tab: "/assistant" }, "back → the chat");
  });

  await browser.close();
  await server.close();
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
