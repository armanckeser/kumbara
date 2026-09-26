# Security Policy

Kumbara is a private, self-hosted personal tool, not a public service. It is not hardened for multi-user or production use.

## Reporting a Vulnerability

If you find a security issue, please report it privately through GitHub Security Advisories:

**[Report a vulnerability](https://github.com/armanckeser/kumbara/security/advisories/new)**

Please do not open a public issue for anything security-sensitive.

## Secrets

All secrets (the SimpleFIN access URL, VAPID keys, database credentials) live in `app/server/.env`, which is git-ignored. Never commit real values. Real financial feed data must never enter a coding agent's context (see `app/CLAUDE.md`).
