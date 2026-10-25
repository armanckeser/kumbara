// Fetch every inbox question's recall cues (place, trip, business kind, same-day charges) in ONE request
// (POST /api/inbox/context, the candidates-batch pattern). The cues are the server's verdicts (R2); a failed
// fetch yields none, so rows fall back to a monogram and no trip band — never a spinner in the way of an
// answer.

import { useEffect, useState } from "react";
import type { InboxContext } from "../../../domain/inbox-context";
import { apiPost } from "../../lib/api";
import type { InboxQuestion } from "./inbox-questions";

/** question key -> its cues. Absent key = not fetched yet, or the rows are gone. */
export type ContextByKey = ReadonlyMap<string, InboxContext>;

/** A question's row ids, its newest (the representative's primary) first — the server reads its day and
 *  descriptor, and leaves all of them out of the same-day list. */
const idsOf = (question: InboxQuestion): string[] => {
  const ids = [question.representative.group.primary.id];
  for (const item of question.items) {
    if (!ids.includes(item.group.primary.id)) ids.push(item.group.primary.id);
    for (const leg of item.group.legs) {
      if (leg.kind !== "synthetic" && !ids.includes(leg.row.id)) ids.push(leg.row.id);
    }
  }
  return ids;
};

export function useInboxContext(questions: readonly InboxQuestion[]): ContextByKey {
  const [byKey, setByKey] = useState<ContextByKey>(new Map());
  const questionsKey = questions.map((question) => question.key).join(",");

  useEffect(() => {
    let cancelled = false;
    if (questions.length === 0) {
      setByKey(new Map());
      return;
    }
    apiPost<{ context_by_key: Record<string, InboxContext> }>("inbox/context", {
      groups: questions.map((question) => ({ key: question.key, ids: idsOf(question) })),
    })
      .then((result) => {
        if (!cancelled) setByKey(new Map(Object.entries(result.context_by_key)));
      })
      .catch(() => {
        if (!cancelled) setByKey(new Map());
      });
    return () => {
      cancelled = true;
    };
    // questionsKey captures the set of questions; the fetch re-runs only when that set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionsKey]);

  return byKey;
}
