// Regression tests for suggestNarrowings — the "what makes this one different?" suggestions offered when an
// answer contradicts what a merchant already means. Each test names the failure it guards, uses only the
// public function, and asserts hardcoded expectations. Pure (plain `it`, no DB).
//
// The load-bearing scenario is a card issuer's portal ("Card Portal") that books rent, dining and travel
// under ONE merchant key: answering Dining for a dining row must yield a narrowing that matches the dining
// rows and none of the rent rows — never "every Card Portal row is Dining".

import { assert, describe, it } from "@effect/vitest";
import type { AccountId, MerchantKey, Money } from "./common";
import type { QuestionRow } from "./rule-question";
import { suggestNarrowings } from "./rule-question";

const PORTAL = "card portal" as MerchantKey;
const CHECKING = "aaaaaaaa-0000-0000-0000-000000000001" as AccountId;
const CARD = "aaaaaaaa-0000-0000-0000-000000000002" as AccountId;

const row = (amount: string, matchText: string | null, accountId: AccountId = CARD): QuestionRow => ({
  merchantKey: PORTAL,
  accountId,
  amount: amount as Money,
  matchText,
});

const RENT = [
  row("-2000.00", "CARD PORTAL RENT PAYMENT 0001", CHECKING),
  row("-2000.00", "CARD PORTAL RENT PAYMENT 0002", CHECKING),
];

describe("suggestNarrowings", () => {
  it("offers the description word that separates dining from rent", () => {
    const dining = [row("-45.20", "CARD PORTAL DINING 8812"), row("-61.00", "CARD PORTAL DINING 9921")];
    const suggestions = suggestNarrowings(PORTAL, dining, RENT);
    const text = suggestions.filter((suggestion) => suggestion.text_match !== null);
    assert.deepStrictEqual(text.map((suggestion) => suggestion.text_match), ["dining"]);
    assert.strictEqual(text[0].covers, 2);
    assert.strictEqual(text[0].also_matches, 0);
  });

  it("never suggests the merchant's own name or bank noise words", () => {
    const dining = [row("-45.20", "CARD PORTAL DINING PURCHASE")];
    const words = suggestNarrowings(PORTAL, dining, RENT).flatMap((suggestion) =>
      suggestion.text_match === null ? [] : [suggestion.text_match],
    );
    assert.isFalse(words.includes("card"));
    assert.isFalse(words.includes("portal"));
    assert.isFalse(words.includes("purchase"));
  });

  it("never suggests a word that the other category's rows also contain", () => {
    const dining = [row("-45.20", "CARD PORTAL RENT DINING")];
    const words = suggestNarrowings(PORTAL, dining, RENT).flatMap((suggestion) =>
      suggestion.text_match === null ? [] : [suggestion.text_match],
    );
    assert.deepStrictEqual(words, ["dining"]);
  });

  it("separates by a round amount ceiling when every other row is larger", () => {
    const dining = [row("-45.20", null), row("-61.00", null)];
    const amount = suggestNarrowings(PORTAL, dining, RENT).find((suggestion) => suggestion.amount_max !== null);
    assert.isDefined(amount);
    assert.strictEqual(amount?.amount_max, "1000.00");
    assert.strictEqual(amount?.amount_min, null);
  });

  it("separates by a round amount floor when every other row is smaller", () => {
    const rent = [row("-2000.00", null, CHECKING)];
    const dining = [row("-45.20", null), row("-61.00", null)];
    const amount = suggestNarrowings(PORTAL, rent, dining).find((suggestion) => suggestion.amount_min !== null);
    assert.strictEqual(amount?.amount_min, "1000.00");
    assert.strictEqual(amount?.amount_max, null);
  });

  it("offers the exact amount for one repeating figure that overlaps the others' range", () => {
    const rent = [row("-2000.00", null), row("-2000.00", null)];
    const mixed = [row("-45.00", null), row("-3000.00", null)];
    const amount = suggestNarrowings(PORTAL, rent, mixed).find((suggestion) => suggestion.amount_min !== null);
    assert.strictEqual(amount?.amount_min, "2000.00");
    assert.strictEqual(amount?.amount_max, "2000.00");
  });

  it("offers no amount rule when the amounts interleave", () => {
    const dining = [row("-45.00", null), row("-3000.00", null)];
    const others = [row("-100.00", null), row("-2000.00", null)];
    const amounts = suggestNarrowings(PORTAL, dining, others).filter(
      (suggestion) => suggestion.amount_min !== null || suggestion.amount_max !== null,
    );
    assert.strictEqual(amounts.length, 0);
  });

  it("offers the account when only the answered rows are on it", () => {
    const dining = [row("-45.20", null, CARD)];
    const account = suggestNarrowings(PORTAL, dining, RENT).find((suggestion) => suggestion.account_id !== null);
    assert.strictEqual(account?.account_id, CARD);
  });

  it("offers the direction when the answer is the only money coming in", () => {
    const credits = [row("25.00", "CARD PORTAL STATEMENT CREDIT")];
    const direction = suggestNarrowings(PORTAL, credits, RENT).find((suggestion) => suggestion.direction !== "either");
    assert.strictEqual(direction?.direction, "in");
  });

  it("with no other rows yet, offers text and the exact amount but no account or direction", () => {
    const dining = [row("-45.20", "CARD PORTAL DINING 8812")];
    const suggestions = suggestNarrowings(PORTAL, dining, []);
    assert.deepStrictEqual(
      suggestions.map((suggestion) => [suggestion.text_match, suggestion.amount_min, suggestion.account_id, suggestion.direction]),
      [
        ["dining", null, null, "either"],
        [null, "45.20", null, "either"],
      ],
    );
  });

  it("returns nothing when nothing tells the rows apart", () => {
    const same = [row("-2000.00", "CARD PORTAL RENT PAYMENT", CHECKING)];
    assert.deepStrictEqual(suggestNarrowings(PORTAL, same, RENT), []);
  });

  it("returns nothing for an empty answer", () => {
    assert.deepStrictEqual(suggestNarrowings(PORTAL, [], RENT), []);
  });
});
