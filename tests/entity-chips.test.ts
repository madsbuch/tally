import { afterAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { sqlite } from "./testDb";
import { entityIdOfHref, entityUrlTransform, remarkEntityIds } from "../src/lib/entityMarkdown";
import { newId } from "../src/lib/ids";

const { addFoodEntry, addStateLog, addBloodReading, createChat, getFoodEntry, updateFoodEntry, deleteFoodEntry } = await import(
  "../src/lib/db"
);
const { resolveEntity, resolveEntityCached, withEntityTitles } = await import("../src/lib/entities");

const MEAL = "meal_01h455vb4pex5vsknk084sn02q";
const CHAT = "chat_01h455vb4pex5vsknk084sn02q";

/** The markdown as the app renders it, each chip written as [[id]]. */
function render(md: string): string {
  const a = ({ href, children }: ComponentProps<"a">) => {
    const id = entityIdOfHref(href);
    return id ? `[[${id}]]` : createElement("a", { href }, children);
  };
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkEntityIds],
      urlTransform: entityUrlTransform,
      components: { a },
      children: md,
    }),
  );
}

describe("ids in coach markdown", () => {
  test("an id in text becomes a chip, punctuation around it stays text", () => {
    expect(render(`You ate ${MEAL}, then (${CHAT}).`)).toBe(`<p>You ate [[${MEAL}]], then ([[${CHAT}]]).</p>`);
  });

  test("ids inside emphasis, lists and tables", () => {
    expect(render(`- **${MEAL}**`)).toContain(`<strong>[[${MEAL}]]</strong>`);
    expect(render(`| a |\n| - |\n| ${MEAL} |`)).toContain(`<td>[[${MEAL}]]</td>`);
  });

  test("an inline code span that is just an id is a chip; other code isn't touched", () => {
    expect(render(`See \`${MEAL}\`.`)).toBe(`<p>See [[${MEAL}]].</p>`);
    expect(render(`Run \`get ${MEAL}\``)).toBe(`<p>Run <code>get ${MEAL}</code></p>`);
  });

  test("fenced code keeps its ids", () => {
    expect(render("```\n" + MEAL + "\n```")).toBe(`<pre><code>${MEAL}\n</code></pre>`);
  });

  test("links keep their text and their URL", () => {
    expect(render(`[${MEAL}](https://example.com/${MEAL})`)).toBe(
      `<p><a href="https://example.com/${MEAL}">${MEAL}</a></p>`,
    );
  });

  test("an id inside a longer word, or not one of ours, stays as written", () => {
    expect(render(`x${MEAL} and lunch_01h455vb4pex5vsknk084sn02q`)).toBe(
      `<p>x${MEAL} and lunch_01h455vb4pex5vsknk084sn02q</p>`,
    );
  });

  test("other unknown schemes are still stripped", () => {
    expect(render("[x](javascript:alert(1))")).toBe(`<p><a href="">x</a></p>`);
    expect(entityIdOfHref("entity:not-an-id")).toBeNull();
  });
});

describe("resolveEntity", () => {
  test("a meal by its title, at its entry page; live through edits and deletes", async () => {
    const id = await addFoodEntry({
      eaten_at: "2026-11-16T08:00:00.000Z",
      title: "Oat porridge",
      description: null,
      photo_path: null,
      nutrients: {},
      model_id: null,
      icon: null,
    });
    const r = await resolveEntity(id);
    expect(r?.title).toBe("Oat porridge");
    expect(r?.path).toBe(`/entry/meal/${id}`);
    expect(r?.glyph).toBe("🥣");

    expect((await resolveEntityCached(id))?.title).toBe("Oat porridge");
    const entry = await getFoodEntry(id);
    if (!entry) throw new Error("meal not written");
    await updateFoodEntry({ ...entry, title: "Porridge with berries" });
    await new Promise((res) => setTimeout(res, 80));
    expect((await resolveEntityCached(id))?.title).toBe("Porridge with berries");

    await deleteFoodEntry(id);
    await new Promise((res) => setTimeout(res, 80));
    expect(await resolveEntityCached(id)).toBeNull();
  });

  test("a chat, an observation and a reading", async () => {
    const chat = await createChat("Protein on rest days", []);
    expect(await resolveEntity(chat)).toEqual({ title: "Protein on rest days", path: `/assistant/${chat}`, glyph: "💬" });

    const obs = await addStateLog({ tags: [{ label: "Fizzy", icon: "🎈" }], note: "after lunch" });
    expect(await resolveEntity(obs)).toEqual({ title: "Fizzy", path: `/entry/state/${obs}`, glyph: "🎈" });

    const reading = await addBloodReading({ kind: "ketone", value: 1.24 });
    expect((await resolveEntity(reading))?.title).toBe("Ketones 1.2 mmol/L");
  });

  test("unknown and missing ids resolve to nothing", async () => {
    expect(await resolveEntity("hello")).toBeNull();
    expect(await resolveEntity(newId("food_entries"))).toBeNull();
  });

  test("text for a notification names what the ids stand for", async () => {
    const chat = await createChat("Sleep and caffeine", []);
    const gone = newId("workouts");
    expect(await withEntityTitles(`See ${chat}; ${gone} is gone.`)).toBe("See Sleep and caffeine; a deleted workout is gone.");
  });
});

// Keep the shared database tidy for files that count rows.
afterAll(() => {
  sqlite.exec("DELETE FROM chats WHERE title IN ('Protein on rest days', 'Sleep and caffeine')");
  sqlite.exec("DELETE FROM state_log_tags WHERE label = 'Fizzy'; DELETE FROM state_logs WHERE note = 'after lunch'");
  sqlite.exec("DELETE FROM blood_readings WHERE kind = 'ketone' AND value = 1.24");
});
