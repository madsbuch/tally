import { describe, expect, test } from "bun:test";
import { at, must } from "./helpers";
import {
  ANSWERING_ELSEWHERE_MS,
  COACH_CONTEXT_MARK,
  STALE_CONTEXT,
  answeringElsewhereUntil,
  awaitsAnswer,
  compactTranscript,
  isCoachContext,
  lastUserIndexOf,
} from "../src/lib/coachTranscript";
import type { ChatMessage } from "../src/lib/schemas";

const big = "x".repeat(2000);

function call(id: string, name: string): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
  };
}

function conversation(): ChatMessage[] {
  return [
    { role: "system", content: "prompt" },
    { role: "user", content: `${COACH_CONTEXT_MARK} Monday digest` },
    { role: "user", content: "How was my week?" },
    call("a", "run_sql"),
    { role: "tool", tool_call_id: "a", content: big },
    call("b", "describe_database"),
    { role: "tool", tool_call_id: "b", content: big },
    call("c", "query_sleep"),
    { role: "tool", tool_call_id: "c", content: "short" },
    { role: "user", content: `${COACH_CONTEXT_MARK} Tuesday digest` },
    { role: "user", content: "And sleep?" },
  ];
}

describe("coach transcript", () => {
  test("context notes are not their messages", () => {
    const msgs = conversation();
    expect(isCoachContext(at(msgs, 1))).toBe(true);
    expect(isCoachContext(at(msgs, 2))).toBe(false);
    expect(lastUserIndexOf(msgs)).toBe(10);
  });

  test("shortens earlier results and notes, keeps the live turn", () => {
    const out = compactTranscript(conversation());
    expect(at(out, 1).content).toBe(STALE_CONTEXT);
    expect(at(out, 4).content).toContain("run_sql result from an earlier turn");
    // The schema stays: it would only be fetched again.
    expect(at(out, 6).content).toBe(big);
    expect(at(out, 8).content).toBe("short");
    // The live note and the message being answered are untouched.
    expect(at(out, 9).content).toBe(`${COACH_CONTEXT_MARK} Tuesday digest`);
    expect(at(out, 10).content).toBe("And sleep?");
  });

  test("is stable: compacting twice changes nothing", () => {
    const once = compactTranscript(conversation());
    expect(compactTranscript(once)).toEqual(once);
  });

  test("leaves the current turn's results alone", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "Q" },
      call("a", "run_sql"),
      { role: "tool", tool_call_id: "a", content: big },
    ];
    expect(compactTranscript(msgs)).toEqual(msgs);
  });
});

describe("awaitsAnswer", () => {
  const q: ChatMessage = { role: "user", content: "How did I sleep?" };
  const note: ChatMessage = { role: "user", content: `${COACH_CONTEXT_MARK} digest` };
  const ok = (id: string): ChatMessage => ({ role: "tool", tool_call_id: id, content: "Delivered." });

  test("a question with nothing after it waits", () => {
    expect(awaitsAnswer([{ role: "system", content: "p" }, note, q])).toBe(true);
  });

  test("so does one the coach is still working on", () => {
    expect(awaitsAnswer([note, q, call("a", "query_sleep"), { role: "tool", tool_call_id: "a", content: "8h" }])).toBe(true);
    expect(awaitsAnswer([q, { role: "assistant", content: "thinking", tool_calls: call("a", "run_sql").tool_calls }])).toBe(true);
  });

  test("a delivery answers it", () => {
    expect(awaitsAnswer([q, call("a", "send_message"), ok("a")])).toBe(false);
    expect(awaitsAnswer([q, call("a", "query_sleep"), ok("a"), call("b", "send_chart"), ok("b")])).toBe(false);
    // Prose without tool calls reached them too.
    expect(awaitsAnswer([q, { role: "assistant", content: "You slept 8h." }])).toBe(false);
  });

  test("only the last question counts", () => {
    const answered = [q, call("a", "send_message"), ok("a")];
    expect(awaitsAnswer([...answered, note, { role: "user", content: "And today?" }])).toBe(true);
    // A context note after an answer isn't a question.
    expect(awaitsAnswer([...answered, note])).toBe(false);
  });

  test("no question, nothing to wait for", () => {
    expect(awaitsAnswer([])).toBe(false);
    // A check-in: the coach spoke first.
    expect(awaitsAnswer([{ role: "system", content: "p" }, { role: "assistant", content: "Morning!" }])).toBe(false);
  });
});

describe("answeringElsewhereUntil", () => {
  test("counts from the time in the clock value", () => {
    expect(answeringElsewhereUntil("1763280000000.000042")).toBe(1763280000000 + ANSWERING_ELSEWHERE_MS);
  });

  test("a clock value that doesn't parse never waits", () => {
    for (const bad of ["", "superseded", "1763280000000", "176328000000.000001", "x763280000000.000001"]) {
      expect(answeringElsewhereUntil(bad)).toBe(0);
    }
  });
});
