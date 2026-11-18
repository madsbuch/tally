/**
 * What the coach writes, as the app shows it: markdown (GFM), with every id
 * in it shown as a chip naming the thing (components/EntityChip). The one
 * place coach text is rendered, so a chat, a manual and an entry's thread all
 * read ids the same way.
 */
import { Fragment } from "react";
import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import type { Components, ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { entityIdOfHref, entityUrlTransform, remarkEntityIds } from "../lib/entityMarkdown";
import { splitTypeIds } from "../lib/ids";
import EntityChip from "./EntityChip";

function MarkdownLink({ href, children }: ComponentProps<"a"> & ExtraProps) {
  const id = entityIdOfHref(href);
  if (id) return <EntityChip id={id} />;
  return <a href={href}>{children}</a>;
}

const COMPONENTS: Components = { a: MarkdownLink };
const PLUGINS = [remarkGfm, remarkEntityIds];

/** Coach markdown, ids shown as chips. */
export default function CoachMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={PLUGINS} urlTransform={entityUrlTransform} components={COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
}

/** Plain text (not markdown) from the coach, ids shown as chips. */
export function EntityText({ text }: { text: string }) {
  return (
    <>
      {splitTypeIds(text).map((part, i) =>
        typeof part === "string" ? <Fragment key={i}>{part}</Fragment> : <EntityChip key={i} id={part.id} />,
      )}
    </>
  );
}
