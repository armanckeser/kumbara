import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "../features/home/home-page";

// `/` is the Home dashboard (Pitch 27): a read-only glance at net worth, accounts, budget, and how much
// triage is left — each card deep-links to its full surface. It replaces the old redirect-to-inbox so
// opening the app answers "where do I stand?" instead of dropping straight into a chore queue.
export const Route = createFileRoute("/")({ component: HomePage });
