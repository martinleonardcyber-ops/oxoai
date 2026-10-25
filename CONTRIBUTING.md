# Contributing to OxoAI

Thank you for considering a contribution. OxoAI is developed in French: the code,
comments and technical documentation are written in French, and the interface is
translated into English, Chinese, Japanese, Spanish, German and Arabic (Arabic reads right to left). Issues and pull requests are welcome in English or
French.

## Before writing code

1. Read [PROJET.md](PROJET.md). It says what the product is, who it is for, and what has
   already been decided. Decisions written there are not reopened without a new reason.
2. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the decision that touches your topic.
3. For anything larger than a fix, open an issue or a discussion first. Three days of work
   declined on principle is a loss for everyone.

## Project rules

Each rule fixes a defect that has already happened in this repository.

- **Every string shown on screen goes through `t("…")`**, or `tf("… {0} …", value)` when
  it contains a value. The French sentence is the translation key (`src/lib/i18n.ts`,
  `gateway/src/langue.ts`). `node scripts/i18n.mjs --ecrire` and
  `node scripts/i18n-passerelle.mjs --ecrire` prepare the new keys; then fill in
  `src/i18n/{en,zh,ja,es,de,ar}.json` and `gateway/i18n/{en,zh,ja,es,de,ar}.json`. Every catalogue stays at 100 %.
- **Layout classes are logical, not physical**: `ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`,
  `text-start`, `text-end`, `border-s`, `border-e`, `rounded-ee`, never `ml-`, `pr-`, `left-`,
  `text-right`, `border-l`. The interface also reads right to left (Arabic), and a physical class
  puts things on the wrong side there. Code, paths, addresses and tokens carry `dir="ltr"` (or the
  `font-mono` class); text typed by a person or written by a model carries `dir="auto"`.
- **No product name in code**: `branding.name` in the interface, `nomProduit()` in the
  gateway. The software ships as a white label.
- **No hard-coded colour** outside `src/styles/tokens.css`.
- **The software does not lie.** A button that does nothing, a state claimed without being
  measured, a green tick that checks nothing: that is a bug, like a crash. Never write
  "verified" or "tested" for what has not been. What has not been tried yet is recorded in
  the project's internal documentation (PROJET.md, SECURITE.md, code comments), not on
  screen nor in the README or release notes: remove the claim, keep any useful advice.
- **Downloads are pinned and verified**: a fixed version, a checksum written in the code, and
  a licence compatible with the project (Apache 2.0 or MIT; exceptions are listed in
  [PROJET.md](PROJET.md)).
- **Never write empty data over data that could not be read.**
- **Comments explain why**, not what: the constraint, the measured error, the path ruled out.
- **Check where the user arrives**, not only in the code. Most defects found here were found
  by using the application.

## Adding a language

The French sentence is the key, so a language is a pair of catalogues plus a few declarations.
For a language with the code `xx`:

1. **Catalogues**: copy `src/i18n/en.json` to `src/i18n/xx.json` and `gateway/i18n/en.json` to
   `gateway/i18n/xx.json`, then translate every value **from the French key**, keeping each
   `{0}`, `{1}`. "Chat", "Cowork", "Code" and the product name are not translated.
2. **Interface** (`src/lib/i18n.ts`): import the catalogue, add the language to `LANGUES` with its
   native name, to `CATALOGUES` and to `locale()`. For a right-to-left language, add its code to
   `LANGUES_RTL`: `dir` on the page, mirrored icons and left-to-right code then follow
   (`src/styles/index.css`).
3. **Gateway** (`gateway/src/langue.ts`): import the catalogue, add the code to `LANGUES`,
   `CATALOGUES` and `LOCALES`. `gateway/src/plan.ts` (`langueDe`, `phraseLangue`) recognises the
   language of a request: add it there if it can be told apart reliably.
4. **Desktop app**: the code in `LANGUES` of `electron/main.cjs`, and a block of texts in
   `electron/textesMiseAJour.cjs` (messages and `RAISONS`) and `electron/zoneNotification.cjs`.
5. **Scripts**: `LANGUES` in `scripts/i18n.mjs` and `scripts/i18n-passerelle.mjs`; the language
   lists of section 44 in `scripts/securite.mjs`, and a pattern in `MENTION_LANGUES` there;
   `scripts/captures/capturer.mjs` and a scene file if the README gets screenshots in that language.
6. **Fonts** (`src/styles/tokens.css`): if the script is not Latin, a `:root:lang(xx)` stack of
   fonts the operating systems already ship. A bundled font needs an OFL, Apache 2.0 or MIT
   licence, recorded in `THIRD_PARTY_NOTICES.md`.
7. **In-app help** (`src/lib/aide.ts`, "Changer la langue") and `docs/GUIDE.md`: name the language.
8. Open the screens in that language, at 1280 and 375 pixels, light and dark, and say in the
   pull request which ones you looked at.

The command line (`cli/`) and the VS Code extension (`extensions/vscode/`) are in French only.

## Before opening a pull request

```bash
npm run typecheck                    # interface and gateway
npm run securite                     # the security suite (over 2,100 checks), against a disposable instance;
                                     # it also runs scripts/essai-fournisseurs.mjs (fake cloud providers)
node scripts/i18n.mjs                # interface translations: 100 %
node scripts/i18n-passerelle.mjs     # gateway translations: 100 %
node scripts/essai-source-github.mjs # in-app updates from GitHub releases, macOS and Windows, offline
node scripts/essai-notes-modeles.mjs # model scores (Epoch AI), published prices, name matching, My usage
```

`essai-notes-modeles.mjs` needs Node 23.6 or later (or add `--experimental-strip-types`). If you
touch the design detection or the command line, also run `npm run essai:design` and
`npm run essai:cli`. If you touch the VS Code extension (`extensions/vscode/`), run
`npm run essai:vscode` (a fake `vscode` module drives the real extension against a disposable
instance); if you touch the Palmier Pro connector or local MCP servers, run
`npm run essai:palmier` (a fake Palmier Pro on a free port; `npm run securite` runs it too).
`essai:cli` and `essai:vscode` also accept `-- --modele`, which uses a model served by LM Studio.

None of these scripts needs a model, a real provider key or the network. Each gateway they start
has a disposable data folder and keeps its data key in a file there (`"chiffrement": "fichier"`
in its `OXOAI_CONFIG`), so the data of your own installation and its keychain entry are not used. If you start a gateway yourself for a test, do the same: point `OXOAI_DATA_DIR` at a
temporary folder, `OXOAI_CONFIG` at a profile containing `{"chiffrement": "fichier"}`, and use a
port other than 8787.

Describe **what you checked, and how**. "Tested" says nothing; "opened screen X, clicked Y,
saw Z in the request" can be verified.

## Security issues

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Licence of contributions

OxoAI is licensed under AGPL-3.0, like HelixAI from which it is derived. By contributing, you
agree that your contribution is published under the same licence. No other agreement is asked.
