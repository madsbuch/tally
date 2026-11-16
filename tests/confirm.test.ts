import { describe, expect, test } from "bun:test";
import { answerConfirm, confirmAction, currentConfirm, subscribeConfirm } from "../src/lib/confirm";

describe("confirmAction", () => {
  test("resolves with the answer and takes the question down", async () => {
    let shown = 0;
    const off = subscribeConfirm(() => shown++);
    const yes = confirmAction("Delete this?", { confirmLabel: "Delete", danger: true });
    expect(currentConfirm()).toMatchObject({ message: "Delete this?", confirmLabel: "Delete", danger: true });
    answerConfirm(true);
    expect(await yes).toBe(true);
    expect(currentConfirm()).toBeNull();

    const no = confirmAction("Delete that?");
    answerConfirm(false);
    expect(await no).toBe(false);
    expect(shown).toBe(4);
    off();
  });

  test("a second question answers the first no", async () => {
    const first = confirmAction("First?");
    const second = confirmAction("Second?");
    expect(await first).toBe(false);
    expect(currentConfirm()?.message).toBe("Second?");
    answerConfirm(true);
    expect(await second).toBe(true);
  });
});
