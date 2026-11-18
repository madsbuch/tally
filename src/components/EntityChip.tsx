/**
 * An id the coach wrote, shown as what it stands for: "🥣 Oat porridge"
 * rather than `meal_01jd4x8m2kf7r9q3vz5w6t0hyc`, and a tap away from its page.
 *
 * Live like any screen: an edit to the meal (here, on another device, by the
 * coach) renames the chip, and deleting it greys the chip out.
 */
import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { entityNoun, entityTables, peekEntity, resolveEntityCached } from "../lib/entities";
import type { ResolvedEntity } from "../lib/entities";
import { prefixOf } from "../lib/ids";
import { useTablesVersion } from "../lib/live";
import { useGo } from "../lib/navigation";

export default function EntityChip({ id }: { id: string }) {
  const prefix = prefixOf(id);
  const version = useTablesVersion(prefix ? entityTables(prefix) : []);
  const go = useGo();
  const [state, setState] = useState<{ id: string; value: ResolvedEntity | null | undefined }>(() => ({
    id,
    value: peekEntity(id),
  }));

  useEffect(() => {
    let alive = true;
    resolveEntityCached(id).then(
      (value) => {
        if (alive) setState({ id, value });
      },
      (e: unknown) => console.warn("Resolving an id failed", id, e),
    );
    return () => {
      alive = false;
    };
  }, [id, version]);

  const noun = prefix ? entityNoun(prefix) : "item";
  const value = state.id === id ? state.value : peekEntity(id);

  if (value === undefined) {
    return (
      <span className="entity-chip entity-chip-loading" title={id}>
        {noun}…
      </span>
    );
  }
  if (value === null) {
    return (
      <span className="entity-chip entity-chip-gone" title={id}>
        deleted {noun}
      </span>
    );
  }

  const label = (
    <>
      {value.glyph && (
        <span className="entity-chip-glyph" aria-hidden>
          {value.glyph}
        </span>
      )}
      <span className="entity-chip-title">{value.title}</span>
    </>
  );
  const path = value.path;
  if (!path) {
    return (
      <span className="entity-chip" title={noun}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="entity-chip entity-chip-link"
      title={`Open ${noun}`}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        go(path);
      }}
    >
      {label}
    </button>
  );
}
