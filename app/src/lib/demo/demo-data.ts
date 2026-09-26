// Fake dataset for the static demo build (VITE_DEMO=1). Every row here is INVENTED — no real financial
// data (R9). `demoSeed()` is a side-effect-free factory (all generation happens inside the call), so when
// VITE_DEMO is unset the whole module is tree-shaken out of the real bundle (see collections.ts).
//
// Rows are the wire (Encoded) shapes the collections stream, so they decode cleanly through the domain
// schemas (useTransactionItems decodes every transaction/link at read time). Dates are anchored to "now"
// so the demo always shows recent months; amounts/merchant choices come from a seeded PRNG so the shape
// is stable within a session.

import type {
  Account,
  Category,
  DeductionRule,
  EquityGrant,
  EquityTranche,
  Holding,
  IncomeSource,
  Institution,
  Lineage,
  Merchant,
  MerchantMemory,
  Person,
  PortfolioSnapshot,
  RecurringSeries,
  Settings,
  Transaction,
  TransactionLink,
} from "../collections";

// Deterministic PRNG (mulberry32) so the generated dataset is stable across reloads within a build.
const mulberry32 = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pad = (value: number): string => String(value).padStart(2, "0");
const ymd = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const noonIso = (date: Date): string =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).toISOString();

export function demoSeed(): Record<string, readonly Record<string, unknown>[]> {
  const random = mulberry32(0x5eed_1234);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const between = (min: number, max: number): number => min + random() * (max - min);
  const money = (value: number): string => value.toFixed(2);
  const today = new Date();
  // A date in a given month offset back from this month (0 = current), on `day`.
  const dayIn = (monthsBack: number, day: number): Date =>
    new Date(today.getFullYear(), today.getMonth() - monthsBack, day);

  // ---- Institutions --------------------------------------------------------------------------------
  const institutions: Institution[] = [
    { id: "inst_northbank", name: "Northbank", domain: "northbank.example", url: null, color: "#2563eb", created_at: noonIso(dayIn(6, 1)), updated_at: noonIso(today) },
    { id: "inst_evervest", name: "Evervest", domain: "evervest.example", url: null, color: "#16a34a", created_at: noonIso(dayIn(6, 1)), updated_at: noonIso(today) },
    { id: "inst_summit", name: "Summit Card", domain: "summitcard.example", url: null, color: "#db2777", created_at: noonIso(dayIn(6, 1)), updated_at: noonIso(today) },
  ];

  // ---- Accounts ------------------------------------------------------------------------------------
  const account = (
    id: string,
    name: string,
    type: Account["type"],
    klass: "asset" | "liability",
    onBudget: boolean,
    institution_id: string,
    balance: string,
  ): Account => ({
    id,
    sfin_account_id: `sfin_${id}`,
    institution_id,
    connection_id: `conn_${institution_id}`,
    name,
    name_source: "provider",
    type,
    class: klass,
    on_budget: onBudget,
    enrollment: "enabled",
    currency: "USD",
    balance,
    balance_override: null,
    available_balance: balance,
    balance_date: ymd(today),
    sync_status: "ok",
    last_synced_at: noonIso(today),
    last_success_at: noonIso(today),
    created_at: noonIso(dayIn(6, 1)),
    updated_at: noonIso(today),
  });

  const accounts: Account[] = [
    account("acc_checking", "Everyday Checking", "checking", "asset", true, "inst_northbank", "4218.63"),
    account("acc_savings", "High-Yield Savings", "savings", "asset", true, "inst_northbank", "18540.00"),
    account("acc_credit", "Summit Rewards Card", "credit_card", "liability", true, "inst_summit", "-1264.48"),
    account("acc_brokerage", "Evervest Brokerage", "investment", "asset", false, "inst_evervest", "62310.12"),
    account("acc_stock", "Employer Stock Plan", "stock_plan", "asset", false, "inst_evervest", "31875.00"),
  ];

  // ---- Categories ----------------------------------------------------------------------------------
  const category = (
    id: string,
    name: string,
    bucket: Category["bucket"],
    predictability: "fixed" | "variable" | null,
    icon: string,
    sort: number,
    actual_source: "derived" | "manual" = "derived",
  ): Category => ({
    id,
    name,
    parent_id: null,
    bucket,
    predictability,
    person_id: null,
    icon,
    color: null,
    actual_source,
    archival_status: "active",
    sort_order: sort,
    created_at: noonIso(dayIn(6, 1)),
    updated_at: noonIso(today),
  });

  const categories: Category[] = [
    category("cat_groceries", "Groceries", "needs", "variable", "🛒", 1),
    category("cat_rent", "Rent", "needs", "fixed", "🏠", 2),
    category("cat_utilities", "Utilities", "needs", "fixed", "💡", 3),
    category("cat_transport", "Transportation", "needs", "variable", "🚗", 4),
    category("cat_insurance", "Insurance", "needs", "fixed", "🛡️", 5),
    category("cat_health", "Healthcare", "needs", "variable", "⚕️", 6),
    category("cat_phone", "Phone & Internet", "needs", "fixed", "📶", 7),
    category("cat_dining", "Dining Out", "wants", "variable", "🍽️", 8),
    category("cat_entertainment", "Entertainment", "wants", "variable", "🎬", 9),
    category("cat_shopping", "Shopping", "wants", "variable", "🛍️", 10),
    category("cat_travel", "Travel", "wants", "variable", "✈️", 11),
    category("cat_subscriptions", "Subscriptions", "wants", "fixed", "🔁", 12),
    category("cat_fitness", "Fitness", "wants", "fixed", "🏋️", 13),
    category("cat_emergency", "Emergency Fund", "savings", null, "🚨", 14),
    category("cat_brokerage", "Brokerage", "savings", null, "📈", 15),
    category("cat_401k", "401(k)", "savings", null, "🏦", 16, "manual"),
    category("cat_salary", "Salary", "income", null, "💰", 17),
    category("cat_interest", "Interest", "income", null, "🪙", 18),
  ];

  // ---- Merchants -----------------------------------------------------------------------------------
  const merchant = (
    key: string,
    name: string,
    defaultCategory: string | null,
    kind: Merchant["kind"],
    source: Merchant["source"],
  ): Merchant => ({
    id: `mrc_${key}`,
    merchant_key: key,
    canonical_name: name,
    default_category_id: defaultCategory,
    kind,
    transfer_override: null,
    mcc: null,
    logo: null,
    source,
    created_at: noonIso(dayIn(6, 1)),
    updated_at: noonIso(today),
  });

  const merchants: Merchant[] = [
    merchant("wholefoods", "Whole Foods Market", "cat_groceries", "merchant", "kb"),
    merchant("traderjoes", "Trader Joe's", "cat_groceries", "merchant", "kb"),
    merchant("safeway", "Safeway", "cat_groceries", "merchant", "kb"),
    merchant("shell", "Shell", "cat_transport", "merchant", "kb"),
    merchant("uber", "Uber", "cat_transport", "merchant", "kb"),
    merchant("chipotle", "Chipotle", "cat_dining", "merchant", "kb"),
    merchant("starbucks", "Starbucks", "cat_dining", "merchant", "kb"),
    merchant("bluebottle", "Blue Bottle Coffee", "cat_dining", "merchant", "kb"),
    merchant("amazon", "Amazon", "cat_shopping", "merchant", "kb"),
    merchant("target", "Target", "cat_shopping", "merchant", "kb"),
    merchant("netflix", "Netflix", "cat_subscriptions", "merchant", "kb"),
    merchant("spotify", "Spotify", "cat_subscriptions", "merchant", "kb"),
    merchant("maxtv", "Max", "cat_subscriptions", "merchant", "kb"),
    merchant("equinox", "Equinox", "cat_fitness", "merchant", "kb"),
    merchant("northbankutil", "City Power & Water", "cat_utilities", "payment", "kb"),
    merchant("fiberlink", "Fiberlink Internet", "cat_phone", "payment", "kb"),
    merchant("safeguard", "Safeguard Insurance", "cat_insurance", "payment", "kb"),
    merchant("oakwood", "Oakwood Apartments", "cat_rent", "payment", "kb"),
    merchant("globex", "Globex Payroll", "cat_salary", "payment", "kb"),
    merchant("delta", "Delta Air Lines", "cat_travel", "merchant", "kb"),
    merchant("cinemax", "Cineplex Theatres", "cat_entertainment", "merchant", "kb"),
    merchant("cvs", "CVS Pharmacy", "cat_health", "merchant", "kb"),
    // Unresolved merchants (no default category) — the inbox's uncategorized anomalies group under these.
    merchant("dailygrind", "SQ *THE DAILY GRIND", null, "merchant", "unresolved"),
    merchant("riverside", "TST* RIVERSIDE BISTRO", null, "merchant", "unresolved"),
    merchant("marketplace", "PAYPAL *MARKETPLACE", null, "payment", "unresolved"),
    merchant("venmo", "VENMO CASHOUT", null, "payment", "unresolved"),
  ];

  // ---- Merchant memory (learned defaults) ----------------------------------------------------------
  const learned = (key: string, categoryId: string): MerchantMemory => ({
    id: `mem_${key}`,
    merchant_key: key,
    person_id: null,
    category_id: categoryId,
    source: "user",
    created_at: noonIso(dayIn(3, 5)),
    updated_at: noonIso(dayIn(3, 5)),
  });
  const merchantMemory: MerchantMemory[] = [
    learned("wholefoods", "cat_groceries"),
    learned("chipotle", "cat_dining"),
    learned("amazon", "cat_shopping"),
  ];

  // ---- Persons -------------------------------------------------------------------------------------
  const persons: Person[] = [
    { id: "person_alex", name: "Alex", created_at: noonIso(dayIn(6, 1)), updated_at: noonIso(today) },
    { id: "person_sam", name: "Sam", created_at: noonIso(dayIn(6, 1)), updated_at: noonIso(today) },
  ];

  // ---- Transactions --------------------------------------------------------------------------------
  const transactions: Transaction[] = [];
  let txnCounter = 0;
  const tx = (fields: {
    account_id: string;
    date: Date;
    amount: number;
    merchant_key: string | null;
    payee: string;
    category_id: string | null;
    person_id?: string | null;
  }): Transaction => {
    txnCounter += 1;
    const id = `txn_${pad(txnCounter)}${pad(Math.floor(txnCounter / 100))}`;
    const categorized = fields.category_id !== null;
    return {
      id,
      account_id: fields.account_id,
      sfin_id: `sf_${id}`,
      status: "posted",
      superseded_by: null,
      posted_at: ymd(fields.date),
      transacted_at: ymd(fields.date),
      amount: money(fields.amount),
      description_raw: fields.payee.toUpperCase(),
      bridge_payee: null,
      imported_payee: fields.payee,
      payee: fields.payee,
      note: null,
      merchant_key: fields.merchant_key,
      merchant_id: fields.merchant_key !== null ? `mrc_${fields.merchant_key}` : null,
      category_id: fields.category_id,
      person_id: fields.person_id ?? null,
      categorized_by: categorized ? "auto" : null,
      confidence: categorized ? between(0.82, 0.98).toFixed(3) : null,
      exclusion: "included",
      import_hash: `hash_${id}`,
      first_seen_at: noonIso(fields.date),
      created_at: noonIso(fields.date),
      updated_at: noonIso(fields.date),
    };
  };

  const groceryMerchants = ["wholefoods", "traderjoes", "safeway"] as const;
  const diningMerchants = ["chipotle", "starbucks", "bluebottle"] as const;
  const payeeOf = (key: string): string =>
    merchants.find((m) => m.merchant_key === key)?.canonical_name ?? key;

  // Four months of recurring bills, income, and everyday spend.
  for (let monthsBack = 3; monthsBack >= 0; monthsBack -= 1) {
    // Income — salary twice, interest once.
    transactions.push(tx({ account_id: "acc_checking", date: dayIn(monthsBack, 1), amount: 5200, merchant_key: "globex", payee: "Globex Payroll", category_id: "cat_salary" }));
    transactions.push(tx({ account_id: "acc_checking", date: dayIn(monthsBack, 15), amount: 5200, merchant_key: "globex", payee: "Globex Payroll", category_id: "cat_salary" }));
    transactions.push(tx({ account_id: "acc_savings", date: dayIn(monthsBack, 28), amount: between(11, 14), merchant_key: null, payee: "Interest Paid", category_id: "cat_interest" }));

    // Fixed bills.
    transactions.push(tx({ account_id: "acc_checking", date: dayIn(monthsBack, 1), amount: -1850, merchant_key: "oakwood", payee: "Oakwood Apartments", category_id: "cat_rent" }));
    transactions.push(tx({ account_id: "acc_checking", date: dayIn(monthsBack, 8), amount: -between(95, 135), merchant_key: "northbankutil", payee: "City Power & Water", category_id: "cat_utilities" }));
    transactions.push(tx({ account_id: "acc_checking", date: dayIn(monthsBack, 10), amount: -79.99, merchant_key: "fiberlink", payee: "Fiberlink Internet", category_id: "cat_phone" }));
    transactions.push(tx({ account_id: "acc_checking", date: dayIn(monthsBack, 12), amount: -142.5, merchant_key: "safeguard", payee: "Safeguard Insurance", category_id: "cat_insurance" }));

    // Subscriptions + fitness on the card.
    transactions.push(tx({ account_id: "acc_credit", date: dayIn(monthsBack, 5), amount: -15.49, merchant_key: "netflix", payee: "Netflix", category_id: "cat_subscriptions" }));
    transactions.push(tx({ account_id: "acc_credit", date: dayIn(monthsBack, 7), amount: -11.99, merchant_key: "spotify", payee: "Spotify", category_id: "cat_subscriptions" }));
    transactions.push(tx({ account_id: "acc_credit", date: dayIn(monthsBack, 9), amount: -15.99, merchant_key: "maxtv", payee: "Max", category_id: "cat_subscriptions" }));
    transactions.push(tx({ account_id: "acc_credit", date: dayIn(monthsBack, 3), amount: -220, merchant_key: "equinox", payee: "Equinox", category_id: "cat_fitness" }));

    // Groceries.
    for (let i = 0; i < 5; i += 1) {
      const key = pick(groceryMerchants);
      transactions.push(tx({ account_id: random() < 0.5 ? "acc_checking" : "acc_credit", date: dayIn(monthsBack, 2 + Math.floor(between(0, 26))), amount: -between(28, 165), merchant_key: key, payee: payeeOf(key), category_id: "cat_groceries" }));
    }
    // Dining.
    for (let i = 0; i < 7; i += 1) {
      const key = pick(diningMerchants);
      transactions.push(tx({ account_id: "acc_credit", date: dayIn(monthsBack, 2 + Math.floor(between(0, 26))), amount: -between(6, 46), merchant_key: key, payee: payeeOf(key), category_id: "cat_dining" }));
    }
    // Transport.
    transactions.push(tx({ account_id: "acc_credit", date: dayIn(monthsBack, 6), amount: -between(32, 64), merchant_key: "shell", payee: "Shell", category_id: "cat_transport" }));
    transactions.push(tx({ account_id: "acc_credit", date: dayIn(monthsBack, 18), amount: -between(11, 38), merchant_key: "uber", payee: "Uber", category_id: "cat_transport" }));
    // Shopping.
    transactions.push(tx({ account_id: "acc_credit", date: dayIn(monthsBack, 14), amount: -between(18, 180), merchant_key: "amazon", payee: "Amazon", category_id: "cat_shopping" }));
    transactions.push(tx({ account_id: "acc_credit", date: dayIn(monthsBack, 22), amount: -between(20, 120), merchant_key: "target", payee: "Target", category_id: "cat_shopping" }));
  }

  // A one-off trip (two months back) and a couple of occasional spends, for variety in the charts.
  transactions.push(tx({ account_id: "acc_credit", date: dayIn(2, 16), amount: -between(380, 520), merchant_key: "delta", payee: "Delta Air Lines", category_id: "cat_travel" }));
  transactions.push(tx({ account_id: "acc_credit", date: dayIn(1, 20), amount: -between(24, 40), merchant_key: "cinemax", payee: "Cineplex Theatres", category_id: "cat_entertainment" }));
  transactions.push(tx({ account_id: "acc_credit", date: dayIn(1, 11), amount: -between(14, 60), merchant_key: "cvs", payee: "CVS Pharmacy", category_id: "cat_health" }));

  // ---- Inbox anomalies (current month, category_id null) -------------------------------------------
  // Cohorts of uncategorized rows from unresolved merchants — the inbox groups these by merchant into one
  // question each, and a category chip resolves the whole cohort (demo-api's set-category shim).
  const anomaly = (account_id: string, day: number, amount: number, key: string): void => {
    transactions.push(tx({ account_id, date: dayIn(0, day), amount, merchant_key: key, payee: payeeOf(key), category_id: null }));
  };
  anomaly("acc_credit", 4, -5.75, "dailygrind");
  anomaly("acc_credit", 9, -6.25, "dailygrind");
  anomaly("acc_credit", 15, -5.75, "dailygrind");
  anomaly("acc_credit", 21, -7.1, "dailygrind");
  anomaly("acc_credit", 6, -48.2, "riverside");
  anomaly("acc_credit", 13, -32.1, "riverside");
  anomaly("acc_credit", 24, -61.4, "riverside");
  anomaly("acc_checking", 8, -25.0, "marketplace");
  anomaly("acc_checking", 19, -60.0, "marketplace");
  anomaly("acc_checking", 17, -40.0, "venmo");

  // ---- Transfer pair with an OPEN candidate link (the inbox's "uncertain link" anomaly) ------------
  const transferOut: Transaction = tx({ account_id: "acc_checking", date: dayIn(0, 20), amount: -500, merchant_key: null, payee: "Transfer to Savings", category_id: null });
  const transferIn: Transaction = tx({ account_id: "acc_savings", date: dayIn(0, 20), amount: 500, merchant_key: null, payee: "Transfer from Checking", category_id: null });
  transactions.push(transferOut, transferIn);
  // Canonical orientation: primary is the lexicographically smaller id (domain/links canonicalTransferPair).
  const [primaryId, relatedId] =
    transferOut.id < transferIn.id ? [transferOut.id, transferIn.id] : [transferIn.id, transferOut.id];
  const links: TransactionLink[] = [
    {
      id: "link_transfer_1",
      kind: "transfer",
      primary_txn_id: primaryId,
      related_txn_id: relatedId,
      amount: "500.00",
      detected_by: "auto",
      confidence: "0.970",
      status: "needs_review",
      disposition_reason: null,
      created_at: noonIso(dayIn(0, 20)),
      updated_at: noonIso(dayIn(0, 20)),
    },
  ];

  // ---- Holdings (Evervest brokerage) ---------------------------------------------------------------
  const holding = (
    id: string,
    symbol: string,
    description: string,
    shares: string,
    cost: string,
    value: string,
  ): Holding => ({
    id,
    account_id: "acc_brokerage",
    sfin_holding_id: `sfh_${id}`,
    symbol,
    description,
    shares,
    cost_basis: cost,
    market_value: value,
    currency: "USD",
    as_of: ymd(today),
    created_at: noonIso(dayIn(6, 1)),
    updated_at: noonIso(today),
  });
  const holdings: Holding[] = [
    holding("hold_vti", "VTI", "Vanguard Total Stock Market ETF", "82.5", "18400.00", "24310.00"),
    holding("hold_vxus", "VXUS", "Vanguard Total International Stock ETF", "140.0", "8200.00", "9050.00"),
    holding("hold_bnd", "BND", "Vanguard Total Bond Market ETF", "95.0", "7300.00", "6980.00"),
    holding("hold_aapl", "AAPL", "Apple Inc.", "40.0", "6400.00", "9120.00"),
    holding("hold_msft", "MSFT", "Microsoft Corp.", "18.0", "5600.00", "7850.00"),
    holding("hold_cash", "VMFXX", "Vanguard Federal Money Market", "5000.0", "5000.00", "5000.00"),
  ];

  // ---- Equity grant + tranches (stock plan) --------------------------------------------------------
  const grants: EquityGrant[] = [
    {
      id: "grant_1",
      account_id: "acc_stock",
      symbol: "GLBX",
      grant_date: ymd(dayIn(30, 15)),
      granted_qty: "800",
      note: "New-hire RSU grant, 4-year vest",
      created_at: noonIso(dayIn(30, 15)),
      updated_at: noonIso(today),
    },
  ];
  const tranches: EquityTranche[] = [];
  for (let i = 0; i < 8; i += 1) {
    const vest = dayIn(24 - i * 6, 15); // every 6 months from ~2y ago forward
    const vested = vest <= today;
    tranches.push({
      id: `tranche_${pad(i + 1)}`,
      grant_id: "grant_1",
      vest_date: ymd(vest),
      qty: "100",
      released_qty: vested ? "68" : null,
      withheld_qty: vested ? "32" : null,
      cost_basis_per_share: vested ? between(38, 52).toFixed(2) : null,
      capital_gains_status: vested ? "short_term" : null,
      created_at: noonIso(dayIn(30, 15)),
      updated_at: noonIso(today),
    });
  }

  // ---- Recurring series (subscriptions page) -------------------------------------------------------
  const series = (
    id: string,
    key: string,
    amount: number,
    confidence: RecurringSeries["confidence"],
    flow: RecurringSeries["flow"] = "out",
  ): RecurringSeries => ({
    id,
    merchant_key: key,
    variant: `monthly-${amount.toFixed(2)}`,
    cadence: "monthly",
    period_days: "30",
    amount_variability: "fixed",
    flow,
    confidence,
    med_amount: money(amount),
    last_amount: money(amount),
    txn_count: 4,
    first_seen: ymd(dayIn(3, 5)),
    last_seen: ymd(dayIn(0, 5)),
    next_expected: ymd(dayIn(-1, 5)),
    regularity: "0.960",
    visibility: "shown",
    lineage_id: null,
    detected_at: noonIso(today),
    created_at: noonIso(dayIn(3, 5)),
    updated_at: noonIso(today),
  });
  const recurringSeries: RecurringSeries[] = [
    // The recurring INBOUND deposit (Pitch 38): flow "in" routes it to the Subscriptions "Income" section
    // and, via the income source below, shows the "paycheck" badge. $10,400/mo == the budget's income.
    series("series_payroll", "globex", 10400, "high", "in"),
    series("series_netflix", "netflix", 15.49, "high"),
    series("series_spotify", "spotify", 11.99, "high"),
    series("series_max", "maxtv", 15.99, "high"),
    series("series_equinox", "equinox", 220, "high"),
    series("series_fiberlink", "fiberlink", 79.99, "medium"),
    series("series_safeguard", "safeguard", 142.5, "medium"),
  ];

  // ---- Paychecks (Pitch 38): one income source bound to the payroll merchant + its deduction rules. Drives
  // the Budget -> Paychecks authoring drawer and the "paycheck" badge on the payroll series. The baked
  // budget summary is independent of these (no generated legs), so no numbers need to reconcile.
  const incomeSources: IncomeSource[] = [
    {
      id: "src_globex",
      name: "Globex Payroll",
      annual_gross: "124800.00", // $5,200 gross x 24 semimonthly periods
      cadence: "semimonthly",
      variability: "fixed",
      merchant_key: "globex",
      status: "active",
      created_at: noonIso(dayIn(6, 1)),
      updated_at: noonIso(today),
    },
  ];
  const deductionRules: DeductionRule[] = [
    {
      id: "ded_401k",
      income_source_id: "src_globex",
      name: "401(k)",
      basis: "percent_of_gross",
      cadence: "every_period",
      percent: "6.00",
      amount: null,
      tax_treatment: "pre_tax",
      category_id: "cat_401k",
      sort_order: 1,
      created_at: noonIso(dayIn(6, 1)),
      updated_at: noonIso(today),
    },
    {
      id: "ded_medical",
      income_source_id: "src_globex",
      name: "Medical premium",
      basis: "fixed_per_period",
      cadence: "every_period",
      percent: null,
      amount: "180.00",
      tax_treatment: "pre_tax",
      category_id: "cat_health",
      sort_order: 2,
      created_at: noonIso(dayIn(6, 1)),
      updated_at: noonIso(today),
    },
    {
      // A monthly-billed HSA on a semimonthly paycheck: it lands on the month-closing (2nd) check only —
      // the very pattern the cadence gate exists for, so the demo shows it off.
      id: "ded_hsa",
      income_source_id: "src_globex",
      name: "HSA",
      basis: "fixed_per_period",
      cadence: "second_period_of_month",
      percent: null,
      amount: "300.00",
      tax_treatment: "pre_tax",
      category_id: "cat_emergency",
      sort_order: 3,
      created_at: noonIso(dayIn(6, 1)),
      updated_at: noonIso(today),
    },
  ];

  // ---- Portfolio value history (the /investments trend, Pitch 41) ---------------------------------
  // ~90 days of daily snapshots per investment account, random-walking DOWN from today's balance so the
  // series ends exactly at the account's current value (the hero number and the chart's last point agree).
  const portfolioSnapshots: PortfolioSnapshot[] = [];
  for (const [accountId, endValue, endCost] of [
    ["acc_brokerage", 62310.12, 50900.0],
    ["acc_stock", 31875.0, null],
  ] as const) {
    let value = endValue;
    const rows: PortfolioSnapshot[] = [];
    for (let daysBack = 0; daysBack < 90; daysBack += 1) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysBack);
      rows.push({
        id: `snap_${accountId}_${pad(daysBack)}`,
        account_id: accountId,
        snapshot_date: ymd(day),
        market_value: money(value),
        cost_basis: endCost === null ? null : money(endCost),
        source: "sync",
        created_at: noonIso(day),
        updated_at: noonIso(day),
      });
      // Walk backward with a slight downward drift so the visible trend reads gently UP toward today.
      value = value * (1 - between(-0.008, 0.011));
    }
    portfolioSnapshots.push(...rows);
  }

  const lineages: Lineage[] = [
    { id: "lineage_streaming", label: "Streaming", created_at: noonIso(dayIn(3, 5)), updated_at: noonIso(today) },
  ];

  const settings: Settings[] = [
    { key: "amount_style", value: "accounting", created_at: noonIso(dayIn(6, 1)), updated_at: noonIso(today) },
  ];

  return {
    account: accounts,
    transaction: transactions,
    merchant: merchants,
    transaction_link: links,
    category: categories,
    institution: institutions,
    holding: holdings,
    portfolio_snapshot: portfolioSnapshots,
    equity_grant: grants,
    equity_tranche: tranches,
    // A demo close for the granted stock, so the per-stock grants view shows a value (migration 0260).
    security_price: [
      { symbol: "GLBX", close: "42.500000", as_of: noonIso(today), created_at: noonIso(today), updated_at: noonIso(today) },
    ],
    person: persons,
    merchant_memory: merchantMemory,
    recurring_series: recurringSeries,
    recurring_lineage: lineages,
    income_source: incomeSources,
    deduction_rule: deductionRules,
    settings,
  };
}
