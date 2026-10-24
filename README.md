<p align="center">
  <img src="img/banner.png" alt="Kumbara: your bank feed, sorted. Bulk triage by merchant, stock plans and paychecks, AI-agent native." width="100%" />
</p>

**Your bank feed, sorted.** One tap files every charge from a merchant.

<p align="center"><b><a href="https://kumbara-demo.armanckeser.com/">Click around the live demo →</a></b> &nbsp;<sub>fake household, runs entirely in your browser</sub></p>

<p align="center">
  <img src="img/inbox.gif" alt="Three taps in the inbox file twelve transactions: one answer covers every charge from a merchant, one confirms a transfer between your own accounts, then the budget" width="340" />
</p>

- Files what it recognizes and asks about the rest once per merchant.
- Pairs transfers between your own accounts, so they never count as spending.
- Needs / Wants / Savings budget with what's left per day.
- Tracks stock grants, investments, and paychecks from gross to net.
- Works with your own AI agent through a read-only DB role and the app's API.

If Kumbara is useful to you, starring the repo helps other people find it, and [armanckeser.com/subscribe](https://armanckeser.com/subscribe) has ways to hear about new releases.

<details>
<summary>Self-host it</summary>

Docker on a Raspberry Pi or any server, single household. Bank data comes through [SimpleFIN](https://www.simplefin.org/) (about $15 a year, paid to them). Setup is in [`app/DEPLOY.md`](app/DEPLOY.md).

</details>

<details>
<summary>Kumbara vs. Actual Budget</summary>

| | **Kumbara** | **Actual** |
|---|---|---|
| **Daily habit** | Clear an inbox of questions, grouped by merchant | Categorize the register, reconcile |
| **Budget style** | Needs / Wants / Savings with what's left per day | Zero-based envelopes |
| **Stock plans (RSUs)** | Grants, vesting schedules, value of what's still coming | Not built in |
| **AI agents** | Designed for one: read-only DB role, every action an API call | Node API for scripts |
| **Bank sync** | SimpleFIN (US/Canada) | SimpleFIN, GoCardless |

</details>

Developing Kumbara: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Released under the GNU Affero General Public License v3.0 — see [LICENSE](LICENSE). If you run a modified version where other people can reach it, the AGPL asks you to publish your changes too.
