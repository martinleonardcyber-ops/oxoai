import { Worker } from "node:worker_threads";

/**
 * La syntaxe d'un fichier JavaScript, contrôlée dans la passerelle elle-même,
 * sans rien exécuter du code contrôlé.
 *
 * ── Pourquoi plus `node --check` (28/09/2026) ───────────────────────────────
 *
 * Le contrôle lançait le binaire de la passerelle avec `--check`. Dans
 * l'application de bureau, ce binaire est celui de OxoAI, et il ne sert de
 * Node qu'avec le fusible RunAsNode ouvert : n'importe quel programme du poste
 * pouvait alors faire tourner son JavaScript sous l'identité de OxoAI, avec
 * ses autorisations (accessibilité, micro, écran). Le fusible est fermé
 * (SECURITE.md, « RunAsNode fermé ») ; il n'y a plus de Node à lancer, et il
 * n'en faut pas : compiler n'est pas exécuter.
 *
 * ── Comment ────────────────────────────────────────────────────────────────
 *
 *  - un script CommonJS (`.cjs`) : `new vm.Script` sur le code entouré de
 *    l'enveloppe de Node (`function (exports, require, module, …) {`), sur la
 *    même ligne pour garder les numéros de ligne. La compilation seule, comme
 *    `node --check` ; la fonction n'est jamais appelée ;
 *  - un module (`.mjs`, `import`, `export`, `await` au premier niveau) :
 *    `new vm.SourceTextModule`, qui compile sans lier ni évaluer. Cette
 *    classe n'existe qu'avec `--experimental-vm-modules` : le contrôle se fait
 *    donc dans un fil (`Worker`) qui porte cette option, et elle seule. Essayé
 *    le 28/09/2026 sous Node 24.21 et dans un `utilityProcess` d'Electron
 *    44.4.5 : le fil démarre, le module se compile ;
 *  - `.js` : comme Node, CommonJS d'abord, module si la syntaxe l'exige.
 *
 * Le code contrôlé n'arrive dans le fil que comme donnée (`workerData`) ; le
 * seul code évalué est celui écrit ci-dessous. L'erreur est rejetée hors du
 * fil sans être rattrapée : Node y joint alors la ligne fautive (`fichier:12`,
 * la ligne, le repère `^`), comme `node --check` l'écrivait.
 *
 * Rend `null` quand le code compile, le texte de l'erreur sinon, et `undefined`
 * quand le contrôle n'a pas pu se faire (fil refusé, délai dépassé) : un
 * contrôle qui ne peut pas se faire n'affirme rien.
 */

export type GenreJs = "script" | "module" | "auto";

/** Le genre d'après l'extension, comme Node le décide (sans lire `package.json` : `.js` est essayé des deux façons). */
export function genreDe(fichier: string): GenreJs {
  const f = fichier.toLowerCase();
  if (f.endsWith(".mjs")) return "module";
  if (f.endsWith(".cjs")) return "script";
  return "auto";
}

/*
 * Le code du fil. Aucune donnée n'y est collée : le code contrôlé, son nom et
 * son genre arrivent par `workerData`.
 */
const CODE_DU_FIL = `
const vm = require("node:vm");
const { workerData, parentPort } = require("node:worker_threads");
const { code, fichier, genre } = workerData;
const ENVELOPPE = "(function (exports, require, module, __filename, __dirname) { ";
// Une ligne « #! » en tête : permise par Node, pas au milieu d'une fonction. Remplacée par un commentaire de même longueur.
const sansDiese = code.startsWith("#!") ? "//" + code.slice(2) : code;
const commeScript = () => { new vm.Script(ENVELOPPE + sansDiese + "\\n})", { filename: fichier }); };
const commeModule = () => { new vm.SourceTextModule(code, { identifier: fichier }); };
const syntaxeDeModule = /Cannot use import statement|Unexpected token 'export'|import\\.meta|await is only valid|Cannot use 'import\\.meta'/;
let erreur = null;
if (genre === "module") {
  try { commeModule(); } catch (e) { erreur = e; }
} else {
  try { commeScript(); } catch (e) { erreur = e; }
  if (erreur && genre === "auto") {
    let erreurModule = null;
    try { commeModule(); } catch (e) { erreurModule = e; }
    if (!erreurModule) erreur = null;
    else if (syntaxeDeModule.test(String(erreur && erreur.message))) erreur = erreurModule;
  }
}
if (erreur) throw erreur;
parentPort.postMessage("ok");
`;

export function controlerSyntaxeJs(code: string, fichier: string, genre: GenreJs = genreDe(fichier), delaiMs = 15_000): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    let fil: Worker;
    try {
      fil = new Worker(CODE_DU_FIL, {
        eval: true,
        execArgv: ["--experimental-vm-modules"],
        workerData: { code, fichier, genre },
        // Rien du poste n'a à y être : le fil ne fait que compiler.
        env: {},
        // L'avertissement « VM Modules is experimental » ne va pas au journal de l'instance.
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
    } catch {
      resolve(undefined);
      return;
    }
    fil.stdout.resume();
    fil.stderr.resume();
    let fini = false;
    const finir = (r: string | null | undefined) => {
      if (fini) return;
      fini = true;
      clearTimeout(delai);
      void fil.terminate().catch(() => {});
      resolve(r);
    };
    const delai = setTimeout(() => finir(undefined), delaiMs);
    fil.on("message", (m) => finir(m === "ok" ? null : undefined));
    fil.on("error", (err) => {
      const e = err as Error & { code?: string };
      // Le fil lui-même refusé (option non permise, mémoire) : rien d'affirmé.
      if (e?.code?.startsWith?.("ERR_WORKER") || !(e?.name === "SyntaxError" || /SyntaxError/.test(String(e?.stack)))) return finir(undefined);
      finir(String(e.stack ?? e.message ?? e));
    });
    fil.on("exit", () => finir(undefined));
  });
}
