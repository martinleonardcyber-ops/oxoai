# Security policy

OxoAI runs on your own machines and holds your organisation's conversations, documents
and credentials. Security reports are taken seriously and handled before any other work.

## Reporting a vulnerability

Please report vulnerabilities **privately**, through GitHub:
[Report a vulnerability](https://github.com/martinleonardcyber-ops/oxoai/security/advisories/new).
You can also open an issue on https://github.com/martinleonardcyber-ops/oxoai/issues.

Please do not open a public issue, discussion or pull request for a vulnerability.

A useful report says:

- the version of OxoAI (Settings › Preferences › About), the system, and how it is
  deployed (single machine, or an instance shared with colleagues);
- what an attacker can do, and from where (another program on the machine, a colleague with
  an account, the local network, a document or web page read by an agent);
- the steps to reproduce it.

## What to expect

OxoAI is maintained by a small team. We aim to acknowledge a report within a few days,
tell you whether we can reproduce it, and keep you informed until a fix is published. With
your agreement, the fix and its advisory will credit you.

## Supported versions

Only the latest published version receives security fixes. Versions are named after their
release date (for example `2026.9.27`); the app announces new versions itself.

## Scope

In scope: the desktop application (`electron/`), the gateway (`gateway/`), the interface
(`src/`), the command line (`cli/`), the installation scripts (`scripts/`), and what OxoAI
downloads and installs (model engine, Python, Node, OpenCode).

Out of scope: vulnerabilities in third-party software OxoAI installs or talks to (LM Studio,
model providers, OpenClaw, OpenCode) unless OxoAI makes them exploitable; reports that
require an already compromised user account on the machine.

## How OxoAI is secured

The security model and every check of the security suite (`npm run securite`, run before each
version) are documented, in French, in [SECURITE.md](SECURITE.md).
