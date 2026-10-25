/*
 * La page « Modèles » (28/09/2026) côté passerelle, de bout en bout contre
 * une passerelle jetable.
 *
 *   node scripts/essai-page-modeles.mjs   (lancé aussi par npm run securite, section 33)
 *
 * Tout vit dans un dossier temporaire : dossier personnel neuf (HOME), données
 * neuves, un faux `lms` (installation simulée, avec sa progression, chaque
 * appel noté), un faux serveur compatible OpenAI à la place de LM Studio, faux
 * `security`, `opencode` et `rtk`. Aucun vrai LM Studio (ni ~/.lmstudio, ni les
 * ports 1234 et 41343), aucun réseau : un module préalable refuse tout `fetch`
 * hors de la boucle locale, et les programmes lancés ont un mandataire muet.
 *
 * A. Le catalogue complet : installé ou non, et la raison chiffrée de ceux qui ne tiennent pas.
 * B. Un modèle trop lourd pour la machine est refusé avant tout téléchargement.
 * C. Un modèle au choix qui tient s'installe par la même route que le sélecteur.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as serveurHttp } from "node:http";
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

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "oxoai-essai-page-modeles-")));
const MAISON = join(TMP, "maison");
const BIN = join(TMP, "bin");
const DONNEES = join(TMP, "donnees");
const LMSTUDIO = join(MAISON, ".lmstudio");
const ETAT = join(TMP, "lms-etat.json");
const APPELS = join(TMP, "lms-appels.log");
for (const d of [MAISON, BIN, DONNEES, join(TMP, "espace"), join(TMP, "Applications"), join(LMSTUDIO, "bin"), join(LMSTUDIO, ".internal"), join(LMSTUDIO, "llmster"), join(LMSTUDIO, "models")]) mkdirSync(d, { recursive: true });
// Un modèle d'écran déjà là (pas le modèle de conversation conseillé : son essai au démarrage occuperait la mise en route).
writeFileSync(ETAT, JSON.stringify({ installes: ["qwen/qwen3-vl-2b"], charges: [] }));
writeFileSync(APPELS, "");
// Le moteur « déclaré », comme après son installation (engine.ts, `moteurAPoser`).
writeFileSync(join(LMSTUDIO, ".internal", "llmster-install-location.json"), JSON.stringify({ path: join(LMSTUDIO, "llmster") }));
writeFileSync(
  join(LMSTUDIO, "bin", "lms"),
  `#!${process.execPath}
const fs = require("node:fs");
const ETAT = ${JSON.stringify(ETAT)};
const lire = () => JSON.parse(fs.readFileSync(ETAT, "utf8"));
const ecrire = (e) => fs.writeFileSync(ETAT, JSON.stringify(e));
const [cmd, ...args] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(APPELS)}, [cmd, ...args].join(" ") + "\\n");
const json = args.includes("--json");
const e = lire();
const fiche = (k) => ({ modelKey: k, path: k, type: "llm", sizeBytes: 2e9 });
if (cmd === "version") { console.log("lms 0.0.47 (essai)"); process.exit(0); }
if (cmd === "ls") { console.log(json ? JSON.stringify(e.installes.map(fiche)) : e.installes.join("\\n")); process.exit(0); }
if (cmd === "ps") { console.log(json ? JSON.stringify(e.charges.map(fiche)) : e.charges.join("\\n")); process.exit(0); }
if (cmd === "get") {
  let p = 0;
  const t = setInterval(() => {
    p += 25;
    console.log("Downloading " + args[0] + " " + p + "%");
    if (p >= 100) { clearInterval(t); const f = lire(); f.installes.push(args[0]); ecrire(f); process.exit(0); }
  }, 200);
  return;
}
if (cmd === "load") { e.charges.push(args[0]); ecrire(e); process.exit(0); }
if (cmd === "unload") { e.charges = e.charges.filter((c) => c !== args[0]); ecrire(e); process.exit(0); }
process.exit(0);
`,
);
chmodSync(join(LMSTUDIO, "bin", "lms"), 0o755);
for (const [nom, corps] of [
  ["security", "#!/bin/sh\nexit 44\n"],
  ["opencode", "#!/bin/sh\necho 1.18.32\n"],
  ["rtk", "#!/bin/sh\necho rtk 0.50.0\n"],
]) {
  writeFileSync(join(BIN, nom), corps);
  chmodSync(join(BIN, nom), 0o755);
}
writeFileSync(join(TMP, "profil.json"), JSON.stringify({ chiffrement: "fichier" }));
const PREALABLE = join(TMP, "prealable.mjs");
writeFileSync(
  PREALABLE,
  `const fetchOrigine = globalThis.fetch;
globalThis.fetch = async (entree, options) => {
  const a = new URL(typeof entree === "string" || entree instanceof URL ? String(entree) : entree.url);
  if (["127.0.0.1", "localhost", "[::1]"].includes(a.hostname)) return fetchOrigine(entree, options);
  throw new TypeError("fetch failed (essai : aucune sortie vers " + a.hostname + ")");
};
`,
);

// Le faux LM Studio : les modèles installés, et une réponse d'essai correcte.
const faux = serveurHttp((req, res) => {
  const e = JSON.parse(readFileSync(ETAT, "utf8"));
  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: e.installes.map((id) => ({ id, object: "model" })) }));
    return;
  }
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Bonjour ! Je vais très bien, merci de demander." }, finish_reason: "stop" }] }));
  });
});
const portLms = await portLibre();
await new Promise((ok) => faux.listen(portLms, "127.0.0.1", ok));

const port = await portLibre();
const G = `http://127.0.0.1:${port}`;
let journal = "";
const passerelle = spawn(process.execPath, ["--import", PREALABLE, join(RACINE, "gateway", "src", "index.ts")], {
  env: {
    PATH: [BIN, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    HOME: MAISON,
    USERPROFILE: MAISON,
    LANG: "C",
    HTTPS_PROXY: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
    OXOAI_CONFIG: join(TMP, "profil.json"),
    OXOAI_DATA_DIR: DONNEES,
    OXOAI_GATEWAY_PORT: String(port),
    OXOAI_WORKSPACE: join(TMP, "espace"),
    OXOAI_MOTEUR: "lmstudio",
    OXOAI_LMSTUDIO_URL: `http://127.0.0.1:${portLms}/v1`,
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
  const entetes = (seance, langue = "fr") => ({ "Content-Type": "application/json", Authorization: `Bearer ${JETON}`, "X-OxoAI-Langue": langue, ...(seance ? { "X-OxoAI-Session": seance } : {}) });
  const appel = async (chemin, seance, corps, langue) => {
    const r = await fetch(`${G}${chemin}`, corps === undefined ? { headers: entetes(seance, langue) } : { method: "POST", headers: entetes(seance, langue), body: JSON.stringify(corps) });
    return { statut: r.status, json: await r.json().catch(() => ({})) };
  };
  // Compte d'essai sur la passerelle jetable (valeurs d'essai).
  const admin = await appel("/oxoai/auth/create", null, { fullName: "Admin Essai", email: "admin@example.test", password: "Admin2Essai!Solide42" });
  const seance = admin.json.session?.token ?? "";

  console.log("A. Le catalogue complet");
  const e0 = (await appel("/oxoai/provision", seance)).json;
  const modeles = e0.modeles ?? [];
  const chat = modeles.filter((m) => m.role === "chat");
  verifier("moteur LM Studio reconnu, rien de piloté par un intégrateur", e0.moteur === "lmstudio" && e0.moteurInstalle === true && e0.managed === false, JSON.stringify({ moteur: e0.moteur, installe: e0.moteurInstalle, managed: e0.managed }));
  verifier("tout le catalogue est rendu (plus de quarante modèles de conversation, des modèles d'écran)", chat.length > 40 && modeles.some((m) => m.role === "gui"), `${chat.length} / ${modeles.length}`);
  verifier("chacun a son éditeur, sa licence (Apache 2.0 ou MIT) et sa taille", modeles.every((m) => m.editeur && ["Apache 2.0", "MIT"].includes(m.licence) && m.downloadGb > 0), modeles.filter((m) => !["Apache 2.0", "MIT"].includes(m.licence)).map((m) => m.key).join(","));
  const lourd = modeles.find((m) => m.key === "deepseek/deepseek-v4-flash");
  verifier("un modèle trop lourd dit pourquoi, chiffré (« demande environ N Go ... cette machine en a M »)", Boolean(lourd?.tropLourd) && /demande environ [\d,]+ Go .*en a [\d,]+/.test(lourd.tropLourd.texte) && lourd.tropLourd.demandeGo > lourd.tropLourd.disponibleGo, JSON.stringify(lourd?.tropLourd));
  verifier("le modèle d'écran déjà là est « installé » (nom sans le préfixe d'éditeur)", modeles.find((m) => m.key === "qwen3-vl-2b")?.installe === true, JSON.stringify(modeles.find((m) => m.key === "qwen3-vl-2b")));
  verifier("la courte liste du sélecteur ne prend aucun modèle au choix", (e0.installables ?? []).every((m) => !m.auChoix), (e0.installables ?? []).map((m) => m.key).join(","));
  verifier("le modèle conseillé n'est pas un modèle au choix", !(e0.recommended?.auChoix), e0.recommended?.key);
  const en = (await appel("/oxoai/provision", seance, undefined, "en")).json;
  const lourdEn = (en.modeles ?? []).find((m) => m.key === "deepseek/deepseek-v4-flash");
  verifier("la raison est dite dans la langue de la personne (anglais)", /needs about [\d.]+ GB of memory; this computer has [\d.]+/.test(lourdEn?.tropLourd?.texte ?? ""), lourdEn?.tropLourd?.texte);

  // La mise en route du démarrage finie (ou rien à faire), avant de demander.
  for (let i = 0; i < 40; i++) {
    const p = (await appel("/oxoai/provision", seance)).json.state?.phase;
    if (!["checking", "downloading", "loading"].includes(p)) break;
    await attendre(250);
  }

  console.log("B. Un modèle trop lourd est refusé avant tout téléchargement");
  const refus = await appel("/oxoai/provision/start", seance, { model: "deepseek/deepseek-v4-flash", role: "chat" });
  await attendre(800);
  verifier("refusé (409) avec la raison chiffrée", refus.statut === 409 && /demande environ [\d,]+ Go/.test(refus.json.error?.message ?? ""), `${refus.statut} ${JSON.stringify(refus.json)}`);
  verifier("rien n'est téléchargé (`lms get` jamais appelé pour lui)", !readFileSync(APPELS, "utf8").includes("get deepseek/deepseek-v4-flash"), readFileSync(APPELS, "utf8").split("\n").filter((l) => l.startsWith("get")).join(" | "));
  const sansSeance = await appel("/oxoai/provision/start", null, { model: "ibm/granite-4-h-micro", role: "chat" });
  verifier("sans séance, l'installation est refusée (401), comme depuis le sélecteur", sansSeance.statut === 401, sansSeance.statut);

  console.log("C. Un modèle au choix qui tient s'installe");
  const micro = modeles.find((m) => m.key === "ibm/granite-4-h-micro");
  verifier("Granite 4.0 H Micro est au catalogue, tient sur la machine, pas encore là", Boolean(micro) && !micro.tropLourd && micro.installe === false, JSON.stringify(micro));
  const lance = await appel("/oxoai/provision/start", seance, { model: "ibm/granite-4-h-micro", role: "chat" });
  let fin = {};
  const vus = new Set();
  for (let i = 0; i < 120; i++) {
    fin = (await appel("/oxoai/provision", seance)).json;
    vus.add(fin.state?.phase);
    if (["ready", "error"].includes(fin.state?.phase) && fin.state?.model === "ibm/granite-4-h-micro") break;
    await attendre(250);
  }
  verifier("la demande part (202) et la mise en route installe ce modèle-là, pas le conseillé", lance.statut === 202 && fin.state?.phase === "ready" && fin.state?.model === "ibm/granite-4-h-micro", `${lance.statut} ${JSON.stringify(fin.state)} ${[...vus].join(",")}`);
  verifier("téléchargé par `lms get` avec sa clé du catalogue de LM Studio", readFileSync(APPELS, "utf8").includes("get ibm/granite-4-h-micro --yes"), readFileSync(APPELS, "utf8").split("\n").filter((l) => l.startsWith("get")).join(" | "));
  verifier("puis « installé » dans le catalogue de la page", (fin.modeles ?? []).find((m) => m.key === "ibm/granite-4-h-micro")?.installe === true, JSON.stringify((fin.modeles ?? []).find((m) => m.key === "ibm/granite-4-h-micro")));
} catch (err) {
  echecs.push(String(err));
  console.log(`  ✗ ${err instanceof Error ? err.stack : err}`);
} finally {
  const fin = new Promise((r) => passerelle.once("exit", r));
  passerelle.kill("SIGTERM");
  await Promise.race([fin, attendre(10_000)]);
  if (passerelle.exitCode === null) passerelle.kill("SIGKILL");
  faux.close();
  if (echecs.length && process.env.OXOAI_ESSAI_BAVARD) console.log(journal.slice(-4000));
  await attendre(1500);
  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (err) {
    console.log(`  (dossier temporaire laissé : ${TMP}, ${err instanceof Error ? err.message : err})`);
  }
}
console.log(`\n${reussis} vérification(s) réussie(s), ${echecs.length} échec(s).`);
process.exit(echecs.length ? 1 : 0);
