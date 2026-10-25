/*
 * Ce que la tournée à l'écran de la 2026.928.6 (28/09/2026) a trouvé du côté
 * de la passerelle, essayé contre une passerelle jetable.
 *
 *   node scripts/essai-tournee-ecran.mjs   (lancé aussi par npm run securite, section 28)
 *
 * L'écran de mise en route affichait « L'installation du moteur a échoué »
 * sous le modèle recommandé, une fois le moteur posé autrement (LM Studio
 * installé à la main depuis lmstudio.ai, comme l'encadré d'erreur le propose,
 * puis « Vérifier à nouveau ») : l'état de la mise en route gardait l'échec.
 *
 * Tout vit dans un dossier temporaire : dossier personnel neuf, données
 * neuves, faux `security`, `lms`, `opencode` et `rtk`. Le moteur est llama.cpp
 * (OXOAI_MOTEUR=llamacpp, macOS seulement) ; son téléchargement est refusé
 * par un module préalable (aucun `fetch` de la passerelle ne sort, chacun est
 * noté), puis un faux `llama-server` est posé à sa place, comme un moteur
 * arrivé autrement. Seul le serveur de fichiers livré (MCP) est pris par
 * `npx`, comme à chaque démarrage, dans le dossier personnel jetable.
 *
 * A. L'échec d'installation du moteur est dit, puis oublié une fois le moteur là.
 * B. Un échec qui ne vient pas du moteur (le modèle) reste affiché.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
let reussis = 0;
const echecs = [];
const verifier = (nom, ok, obtenu) => {
  if (ok) {
    reussis++;
    console.log(`  ✓ ${nom}`);
  } else {
    echecs.push(nom);
    console.log(`  ✗ ${nom}  —  obtenu : ${String(obtenu).slice(0, 400)}`);
  }
};
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const portLibre = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

if (process.platform !== "darwin") {
  // Le moteur ouvert n'est forcé que sur macOS (llamaCppBase.ts) : ailleurs, rien à essayer ici.
  console.log("  (llama.cpp forcé sur macOS seulement : essai sauté sur ce système)");
  console.log(`\n${reussis} vérification(s) réussie(s), ${echecs.length} échec(s).`);
  process.exit(0);
}

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "oxoai-essai-tournee-")));
const MAISON = join(TMP, "maison");
const BIN = join(TMP, "bin");
const DONNEES = join(TMP, "donnees");
for (const d of [MAISON, BIN, DONNEES, join(TMP, "espace"), join(TMP, "Applications")]) mkdirSync(d, { recursive: true });
for (const [nom, corps] of [
  ["security", "#!/bin/sh\nexit 44\n"],
  ["lms", "#!/bin/sh\nexit 1\n"],
  ["opencode", "#!/bin/sh\necho 1.18.32\n"],
  ["rtk", "#!/bin/sh\necho rtk 0.50.0\n"],
]) {
  writeFileSync(join(BIN, nom), corps);
  chmodSync(join(BIN, nom), 0o755);
}
writeFileSync(join(TMP, "profil.json"), JSON.stringify({ chiffrement: "fichier" }));
const SORTIES = join(TMP, "sorties.log");
const PREALABLE = join(TMP, "prealable.mjs");
writeFileSync(
  PREALABLE,
  `import { appendFileSync } from "node:fs";
const fetchOrigine = globalThis.fetch;
globalThis.fetch = async (entree, options) => {
  const a = new URL(typeof entree === "string" || entree instanceof URL ? String(entree) : entree.url);
  if (["127.0.0.1", "localhost", "[::1]"].includes(a.hostname)) return fetchOrigine(entree, options);
  appendFileSync(${JSON.stringify(SORTIES)}, a.href + "\\n");
  throw new TypeError("fetch failed (essai : aucune sortie vers " + a.hostname + ")");
};
`,
);

const port = await portLibre();
const G = `http://127.0.0.1:${port}`;
let journal = "";
const passerelle = spawn(process.execPath, ["--import", PREALABLE, join(RACINE, "gateway", "src", "index.ts")], {
  env: {
    PATH: [BIN, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    HOME: MAISON,
    LANG: "C",
    OXOAI_CONFIG: join(TMP, "profil.json"),
    OXOAI_DATA_DIR: DONNEES,
    OXOAI_GATEWAY_PORT: String(port),
    OXOAI_WORKSPACE: join(TMP, "espace"),
    OXOAI_MOTEUR: "llamacpp",
    OXOAI_LLAMACPP_PORT: String(await portLibre()),
    OXOAI_LMSTUDIO_URL: "http://127.0.0.1:9/v1",
    OXOAI_EXO_URL: "http://127.0.0.1:9/v1",
    OXOAI_APPS_DIR: join(TMP, "Applications"),
    OXOAI_OPENCODE_BIN: join(BIN, "opencode"),
    OXOAI_RTK_BIN: join(BIN, "rtk"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
passerelle.stdout.on("data", (b) => (journal += b));
passerelle.stderr.on("data", (b) => (journal += b));

try {
  let JETON = "";
  for (let i = 0; i < 160 && !JETON; i++) {
    try {
      await fetch(`${G}/health`);
      JETON = readFileSync(join(DONNEES, "instance-token"), "utf8").trim();
    } catch {
      await attendre(250);
    }
  }
  if (!JETON) throw new Error(`passerelle muette :\n${journal.slice(-2000)}`);
  const entetes = (seance) => ({ "Content-Type": "application/json", Authorization: `Bearer ${JETON}`, "X-OxoAI-Langue": "fr", ...(seance ? { "X-OxoAI-Session": seance } : {}) });
  const appel = async (chemin, seance, corps) => {
    const r = await fetch(`${G}${chemin}`, corps === undefined ? { headers: entetes(seance) } : { method: "POST", headers: entetes(seance), body: JSON.stringify(corps) });
    return { statut: r.status, json: await r.json().catch(() => ({})) };
  };
  const etat = async () => (await appel("/oxoai/provision")).json;
  const attendrePhase = async (phase) => {
    for (let i = 0; i < 120; i++) {
      const e = await etat();
      if (e.state?.phase === phase) return e;
      await attendre(250);
    }
    return etat();
  };

  const admin = await appel("/oxoai/auth/create", null, { fullName: "Admin Essai", email: "admin@example.test", password: "Admin2Essai!Solide42" });
  const seance = admin.json.session?.token ?? "";

  console.log("A. L'échec d'installation du moteur, puis le moteur arrivé autrement");
  const e0 = await etat();
  verifier("au départ : llama.cpp, moteur absent, rien en cours", e0.moteur === "llamacpp" && e0.moteurInstalle === false && e0.state?.phase === "idle", JSON.stringify(e0.state));
  const pose = await appel("/oxoai/provision/moteur", seance, {});
  verifier("l'installation du moteur démarre (202)", pose.statut === 202, `${pose.statut} ${JSON.stringify(pose.json).slice(0, 200)}`);
  const e1 = await attendrePhase("error");
  verifier("téléchargement refusé : l'échec est dit (« L'installation du moteur a échoué. »)", e1.state?.phase === "error" && /L'installation du moteur a échoué/.test(e1.state?.message ?? "") && e1.moteurInstalle === false, JSON.stringify(e1.state));
  verifier("rien n'est sorti ailleurs que vers le dépôt de llama.cpp", existsSync(SORTIES) && readFileSync(SORTIES, "utf8").trim().split("\n").every((l) => l.startsWith("https://github.com/ggml-org/llama.cpp/")), existsSync(SORTIES) ? readFileSync(SORTIES, "utf8") : "aucune");

  // Le moteur posé autrement : un exécutable à la place de llama-server (il n'est pas lancé : aucun modèle).
  const dossierMoteur = join(DONNEES, "llamacpp", "b11146");
  mkdirSync(dossierMoteur, { recursive: true });
  writeFileSync(join(dossierMoteur, "llama-server"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dossierMoteur, "llama-server"), 0o755);
  const e2 = await etat();
  verifier("moteur là : l'échec d'installation n'est plus affiché sous le modèle recommandé", e2.moteurInstalle === true && e2.state?.phase === "idle" && !e2.state?.error, JSON.stringify(e2.state));
  const e3 = await etat();
  verifier("et il ne revient pas à la lecture suivante", e3.state?.phase === "idle", JSON.stringify(e3.state));

  console.log("B. Un échec qui ne vient pas du moteur reste affiché");
  const modele = await appel("/oxoai/provision/start", seance, {});
  verifier("le téléchargement du modèle démarre", modele.statut === 202 || modele.statut === 200, `${modele.statut} ${JSON.stringify(modele.json).slice(0, 200)}`);
  const e4 = await attendrePhase("error");
  verifier("téléchargement du modèle refusé : l'échec est dit", e4.state?.phase === "error" && /téléchargement/i.test(e4.state?.message ?? ""), JSON.stringify(e4.state));
  const e5 = await etat();
  verifier("cet échec-là n'est pas effacé à la lecture suivante (il ne concerne pas le moteur)", e5.state?.phase === "error" && e5.state?.message === e4.state?.message, JSON.stringify(e5.state));
  // Le 28/09/2026, un téléchargement raté lançait quand même la dictée en fond : Python et son modèle, 850 Mo.
  await attendre(1500);
  verifier("modèle non installé : la dictée ne s'installe pas en fond", !/Installation de la dictée en arrière-plan/.test(journal), journal.split("\n").filter((l) => /dictée/.test(l)).join(" | "));
} catch (err) {
  echecs.push(String(err));
  console.log(`  ✗ ${err instanceof Error ? err.stack : err}`);
} finally {
  const fin = new Promise((r) => passerelle.once("exit", r));
  passerelle.kill("SIGTERM");
  await Promise.race([fin, attendre(10_000)]);
  if (passerelle.exitCode === null) passerelle.kill("SIGKILL");
  if (echecs.length && process.env.OXOAI_ESSAI_BAVARD) console.log(journal.slice(-4000));
  // Un fils de la passerelle peut écrire encore un instant après son arrêt (ENOTEMPTY vu le 28/09/2026) : on réessaie, sans faire échouer l'essai.
  await attendre(1500);
  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (err) {
    console.log(`  (dossier temporaire laissé : ${TMP}, ${err instanceof Error ? err.message : err})`);
  }
}
console.log(`\n${reussis} vérification(s) réussie(s), ${echecs.length} échec(s).`);
process.exit(echecs.length ? 1 : 0);
