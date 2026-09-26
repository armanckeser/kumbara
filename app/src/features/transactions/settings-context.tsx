// The active amount-display style, exposed to the whole tree via context so the row cells, the
// group-header net total, and the detail sheet all read ONE value (R2/R4: the setting lives in Postgres,
// streams via Electric, and is consumed from a single place here). The provider derives the style from
// the settings collection; consumers call useAmountStyle().

import { createContext, useContext, type ReactNode } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { Schema } from "effect";
import {
  AMOUNT_STYLE_KEY,
  AmountStyle,
  DEFAULT_AMOUNT_STYLE,
} from "../../../domain/settings";
import { settingsCollection, type Settings } from "../../lib/collections";

const AmountStyleContext = createContext<AmountStyle>(DEFAULT_AMOUNT_STYLE);

/** The active amount style. Falls back to the default when no provider is mounted (graceful degrade). */
export function useAmountStyle(): AmountStyle {
  return useContext(AmountStyleContext);
}

// Validate the streamed string against the enum at the consumption boundary (R8): an unknown/garbage
// value (or a row that hasn't streamed yet) degrades to the default rather than rendering a broken style.
const decodeStyle = Schema.decodeUnknownOption(AmountStyle);

function resolveAmountStyle(settings: Settings[]): AmountStyle {
  const row = settings.find((setting) => setting.key === AMOUNT_STYLE_KEY);
  if (row === undefined) return DEFAULT_AMOUNT_STYLE;
  const decoded = decodeStyle(row.value);
  return decoded._tag === "Some" ? decoded.value : DEFAULT_AMOUNT_STYLE;
}

/** Subscribes to the settings collection and publishes the resolved amount style to the tree. */
export function AmountStyleProvider({ children }: { children: ReactNode }) {
  const { data } = useLiveQuery((q) =>
    q.from({ settingsCollection }).select(({ settingsCollection }) => settingsCollection),
  );
  const style = resolveAmountStyle((data ?? []) as Settings[]);
  return <AmountStyleContext.Provider value={style}>{children}</AmountStyleContext.Provider>;
}
