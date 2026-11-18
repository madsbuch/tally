// ---------------------------------------------------------------------------
// Ids in the coach's markdown, made into something the screen can show as a
// chip (components/EntityChip) instead of `meal_01jd4x8m2kf7r9q3vz5w6t0hyc`.
//
// A remark plugin: every id in a text node — and an inline code span that is
// nothing but an id, since models like to backtick them — becomes a link to
// `entity:<id>`, which the markdown's `a` renders as a chip. Fenced code is
// left as it was written, and so is anything already inside a link (a chip
// can't sit inside another link, and a URL isn't text).
// ---------------------------------------------------------------------------

import type { Link, Parent, Root, RootContent } from "mdast";
import { defaultUrlTransform } from "react-markdown";
import { parseTypeId, splitTypeIds } from "./ids";

const SCHEME = "entity:";

/** The href an id's chip is carried in. */
export function entityHref(id: string): string {
  return `${SCHEME}${id}`;
}

/** The id an `entity:` href carries, or null for any other href. */
export function entityIdOfHref(href: string | null | undefined): string | null {
  if (!href?.startsWith(SCHEME)) return null;
  const id = href.slice(SCHEME.length);
  return parseTypeId(id) ? id : null;
}

/**
 * react-markdown's URL filter, letting `entity:` through: by default it
 * strips any scheme it doesn't know, which would leave the chip no id.
 */
export function entityUrlTransform(url: string): string {
  return entityIdOfHref(url) ? url : defaultUrlTransform(url);
}

function entityLink(id: string): Link {
  return { type: "link", url: entityHref(id), title: null, children: [{ type: "text", value: id }] };
}

/** The id an inline code span holds, when that's all it holds. */
function codeId(value: string): string | null {
  const parts = splitTypeIds(value.trim());
  const only = parts.length === 1 ? parts[0] : undefined;
  return only && typeof only !== "string" ? only.id : null;
}

function rewrite(node: Parent): void {
  const out: RootContent[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      const parts = splitTypeIds(child.value);
      if (parts.every((p) => typeof p === "string")) {
        out.push(child);
        continue;
      }
      for (const part of parts) {
        out.push(typeof part === "string" ? { type: "text", value: part } : entityLink(part.id));
      }
    } else if (child.type === "inlineCode") {
      const id = codeId(child.value);
      out.push(id ? entityLink(id) : child);
    } else {
      // No chips inside a link: it would be a link in a link.
      if ("children" in child && child.type !== "link" && child.type !== "linkReference") rewrite(child);
      out.push(child);
    }
  }
  node.children = out;
}

/** The remark plugin: ids in text become `entity:` links. */
export function remarkEntityIds() {
  return (tree: Root): void => rewrite(tree);
}
