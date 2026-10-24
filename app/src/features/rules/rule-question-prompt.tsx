// The rule-question prompt — what the app asks when an answer contradicts what a merchant meant ("Card Portal
// was Rent before — what makes this one Dining?") or the merchant is marked as varying. The server decides
// WHEN to ask and WHAT to suggest (domain/rule-question.ts, R2); this file only queues the questions every
// categorize write returns and renders them one at a time.
//
// Any surface that categorizes (inbox chip, inbox sheet, ledger triage, transaction sheet) hands the write's
// `rule_questions` to askRuleQuestions; the single host mounted in the root layout shows them. One queue, one
// prompt, so a question raised on one page survives navigation and never stacks two sheets.

import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { RuleQuestion, RuleSuggestion } from "../../../domain/rule-question";
import { apiPost } from "../../lib/api";
import { conditionPhrases, type RuleNames } from "./describe";
import { useRuleNames } from "./use-rule-names";

// ---------- the queue (module-level: one per app, readable from any write path) ----------

let queue: ReadonlyArray<RuleQuestion> = [];
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Queue the questions a categorize write returned (absent / empty is a no-op, so every call site can pass
 *  the response field straight through). A question for a merchant already waiting replaces the older one —
 *  the newest answer is the one the user is thinking about. */
export const askRuleQuestions = (questions: ReadonlyArray<RuleQuestion> | undefined): void => {
  if (questions === undefined || questions.length === 0) return;
  const incoming = new Set(questions.map((question) => question.merchant_key));
  queue = [...queue.filter((question) => !incoming.has(question.merchant_key)), ...questions];
  emit();
};

const dismissCurrent = () => {
  queue = queue.slice(1);
  emit();
};

// ---------- presentation ----------

/** A suggestion as the rule it becomes: "text contains “dining”", "at most $500.00". */
const suggestionLabel = (suggestion: RuleSuggestion, names: RuleNames): string => {
  const phrase = conditionPhrases(suggestion, names).join(" · ");
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
};

/** The root-layout host: renders the head of the queue, if any. */
export function RuleQuestionHost() {
  const current = useSyncExternalStore(subscribe, () => queue[0] ?? null);
  return (
    <Sheet
      open={current !== null}
      onOpenChange={(open) => {
        if (!open) dismissCurrent();
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-md">
        {current !== null && (
          <QuestionBody key={`${current.merchant_key}:${current.category_id}`} question={current} onDone={dismissCurrent} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function QuestionBody({ question, onDone }: { question: RuleQuestion; onDone: () => void }) {
  const names = useRuleNames();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customText, setCustomText] = useState("");

  const merchant = names.merchant(question.merchant_key);
  const category = names.category(question.category_id);
  const previous = question.previous_category_id === null ? null : names.category(question.previous_category_id);
  const these = question.answered === 1 ? "this one" : `these ${question.answered}`;

  const answer = (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    apiPost("categorization/answer-rule-question", {
      merchant_key: question.merchant_key,
      category_id: question.category_id,
      person_id: null,
      answer: body,
    })
      .then(onDone)
      .catch((cause: unknown) => setError(String(cause)))
      .finally(() => setBusy(false));
  };
  const narrow = (fields: Pick<RuleSuggestion, "account_id" | "direction" | "amount_min" | "amount_max" | "text_match">) =>
    answer({ _tag: "Narrow", ...fields });

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-5">
      <SheetHeader className="p-0 pr-8">
        <SheetTitle>
          {previous !== null ? `${merchant} was ${previous} before` : `${merchant} varies`}
        </SheetTitle>
        <SheetDescription>
          {previous !== null
            ? `You marked ${these} ${category}. What makes ${question.answered === 1 ? "it" : "them"} ${category}? Nothing has changed for the rest of ${merchant} yet.`
            : `You marked ${these} ${category}. Learn a rule so others like ${question.answered === 1 ? "it" : "them"} are ${category} automatically?`}
        </SheetDescription>
      </SheetHeader>

      {question.example_text !== null && (
        <p className="truncate rounded-md bg-surface-raised/60 px-3 py-2 font-mono text-xs text-text-secondary">
          {question.example_text}
        </p>
      )}

      {question.suggestions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{category} when…</p>
          {question.suggestions.map((suggestion) => (
            <Button
              key={suggestionLabel(suggestion, names)}
              variant="outline"
              className="h-auto justify-start py-2 text-left"
              disabled={busy}
              onClick={() => narrow(suggestion)}
            >
              <span className="flex flex-col">
                <span>{suggestionLabel(suggestion, names)}</span>
                {previous !== null && (
                  <span className="text-xs font-normal text-text-muted">
                    Matches {question.answered === 1 ? "this one" : `all ${question.answered}`}, none of your {previous} ones
                  </span>
                )}
              </span>
            </Button>
          ))}
        </div>
      )}

      <form
        className="flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const text = customText.trim();
          if (text.length === 0) return;
          narrow({ account_id: null, direction: "either", amount_min: null, amount_max: null, text_match: text });
        }}
      >
        <label htmlFor="rule-question-text" className="text-xs text-text-muted">
          {question.suggestions.length > 0 ? "Or: the description contains" : `${category} when the description contains`}
        </label>
        <div className="flex gap-2">
          <Input
            id="rule-question-text"
            value={customText}
            onChange={(event) => setCustomText(event.target.value)}
            placeholder="a word from the description"
            disabled={busy}
          />
          <Button type="submit" variant="outline" disabled={busy || customText.trim().length === 0}>
            Save
          </Button>
        </div>
      </form>

      <div className="flex flex-col gap-1.5 border-t border-border pt-3">
        {question.policy === "single" && (
          <>
            <Button variant="ghost" className="justify-start" disabled={busy} onClick={() => answer({ _tag: "Replace" })}>
              Every {merchant} is {category} now
            </Button>
            <Button variant="ghost" className="justify-start" disabled={busy} onClick={() => answer({ _tag: "Varies" })}>
              It varies — stop guessing, ask me each time
            </Button>
          </>
        )}
        <Button variant="ghost" className="justify-start" disabled={busy} onClick={onDone}>
          Just this once
        </Button>
      </div>

      {error !== null && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
