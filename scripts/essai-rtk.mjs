/*
 * RTK de bout en bout dans OxoAI Code, avec le vrai OpenCode et le vrai RTK.
 *
 *   node scripts/essai-rtk.mjs
 *
 * Écrit le 28/09/2026 (gateway/src/rtk.ts, SECURITE.md § 50). Ce que la
 * batterie (`npm run securite`, section 16) vérifie avec des doublures, ici
 * pour de vrai :
 *  - une passerelle jetable (dossier personnel, données et projet neufs, clé en
 *    fichier, faux `security` en tête du PATH, LM Studio éteint) pose RTK
 *    elle-même : téléchargement de la version épinglée depuis github.com,
 *    empreinte vérifiée ;
 *  - le vrai OpenCode (`~/.opencode/bin/opencode`, ou `OXOAI_ESSAI_OPENCODE`)
 *    tourne avec un dossier personnel jetable, et **aucun modèle** : un faux
 *    fournisseur, servi ici, joue le modèle et demande une commande `bash` ;
 *  - la carte d'accord montre la commande d'origine, l'accord la fait passer
 *    par RTK (sortie condensée dans ce que le « modèle » reçoit), un refus ne
 *    lance rien, une commande inconnue de RTK passe telle quelle, le réglage
 *    « cloud » est tenu (modèle local sans RTK, sauf « toujours ») ;
 *  - la télémétrie de RTK ne part pas : avec un consentement écrit dans un
 *    dossier personnel jetable, `RTK_TELEMETRY_DISABLED=1` empêche même la
 *    marque d'envoi (témoin sans la variable, réseau coupé par sandbox-exec).
 *
 * Rien n'est installé sur le poste : tout vit dans un dossier temporaire,
 * effacé à la fin. Aucun port fixe, ni `~/.oxoai`, ni trousseau, ni `lms`.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as serveurHttp } from "node:http";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const OPENCODE = process.env.OXOAI_ESSAI_OPENCODE ?? join(homedir(), ".opencode", "bin", "opencode");
if (!existsSync(OPENCODE)) {
  console.log(`OpenCode introuvable (${OPENCODE}) : essai impossible sur ce poste.`);
  process.exit(2);
}
const portLibre = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = mkdtempSync(join(tmpdir(), "oxoai-essai-rtk-"));
const MAISON = join(TMP, "maison");
const DONNEES = join(TMP, "donnees");
const PROJET = join(TMP, "projet");
const BIN = join(TMP, "bin");
const RTK_COPIE = join(TMP, "rtk-copie");
for (const d of [MAISON, DONNEES, PROJET, BIN]) mkdirSync(d, { recursive: true });
// Un faux `security` : le vrai ne doit jamais être appelé depuis un dossier personnel jetable.
writeFileSync(join(BIN, "security"), `#!/bin/sh\necho "$@" >> "${join(TMP, "security.log")}"\nexit 44\n`);
chmodSync(join(BIN, "security"), 0o755);
const PATH = [BIN, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");

// Un dépôt jetable : quelques commits et des changements en cours.
const git = (...a) => execFileSync("git", a, { cwd: PROJET, env: { PATH, HOME: MAISON, GIT_AUTHOR_NAME: "Essai", GIT_AUTHOR_EMAIL: "essai@example.invalid", GIT_COMMITTER_NAME: "Essai", GIT_COMMITTER_EMAIL: "essai@example.invalid", LANG: "C" }, encoding: "utf8" });
git("init", "-q", "-b", "main", ".");
for (let i = 1; i <= 12; i++) {
  writeFileSync(join(PROJET, `f${i}.txt`), `fichier ${i}\n`.repeat(i));
  git("add", `f${i}.txt`);
  git("commit", "-qm", `Ajout du fichier ${i}`);
}
for (const i of [2, 5, 7]) writeFileSync(join(PROJET, `f${i}.txt`), "modifié\n");
for (const n of ["nouveau-a.txt", "nouveau-b.txt"]) writeFileSync(join(PROJET, n), "x\n");

/*
 * Le faux fournisseur : un modèle local (« local-essai », servi comme exo) et
 * un modèle cloud (« nuage-essai », du profil : origine « agence »). Une
 * demande avec outils reçoit un appel `bash` choisi par le repère de la
 * demande ; une fois le résultat revenu, « Terminé. ». Les résultats d'outil
 * reçus sont gardés : c'est ce que le vrai modèle aurait lu.
 */
const COMMANDES = {
  "RTK-GIT": "git status",
  "RTK-ECHO": "echo bonjour-rtk",
  "RTK-REFUS": "git status && touch temoin-refus.txt",
};
const RESULTATS = [];
const fournisseur = (nom) =>
  serveurHttp((req, res) => {
    let corps = "";
    req.on("data", (b) => (corps += b));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: nom }] }));
      if (req.url !== "/v1/chat/completions") {
        res.statusCode = 404;
        return res.end("{}");
      }
      const d = JSON.parse(corps || "{}");
      const messages = d.messages ?? [];
      const dernierUtilisateur = messages.findLastIndex((m) => m.role === "user");
      const texteUtilisateur = JSON.stringify(messages[dernierUtilisateur]?.content ?? "");
      const outils = messages.slice(dernierUtilisateur + 1).filter((m) => m.role === "tool");
      const repere = Object.keys(COMMANDES).find((r) => texteUtilisateur.includes(r));
      const envoyer = (delta, fin) => {
        if (!d.stream) {
          return res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: delta.content ?? "", ...(delta.tool_calls ? { tool_calls: delta.tool_calls } : {}) }, finish_reason: fin }] }));
        }
        res.setHeader("Content-Type", "text/event-stream");
        res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: nom, choices: [{ index: 0, delta: { role: "assistant", ...delta } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: nom, choices: [{ index: 0, delta: {}, finish_reason: fin }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      };
      if (!d.tools?.length || !repere) return envoyer({ content: "Titre d'essai" }, "stop");
      if (outils.length) {
        for (const o of outils) RESULTATS.push({ repere, modele: nom, contenu: typeof o.content === "string" ? o.content : JSON.stringify(o.content) });
        return envoyer({ content: "Terminé." }, "stop");
      }
      const args = JSON.stringify({ command: COMMANDES[repere], description: "Essai" });
      envoyer({ tool_calls: [{ index: 0, id: `appel_${Date.now()}`, type: "function", function: { name: "bash", arguments: args } }] }, "tool_calls");
    });
  });
const PORT_LOCAL = await portLibre();
const PORT_NUAGE = await portLibre();
// Un troisième : un modèle cloud branché par une clé personnelle (portée « moi », origine « cle »).
const PORT_PERSO = await portLibre();
const serveurs = [fournisseur("local-essai"), fournisseur("nuage-essai"), fournisseur("perso-essai")];
await new Promise((ok) => serveurs[0].listen(PORT_LOCAL, "127.0.0.1", ok));
await new Promise((ok) => serveurs[1].listen(PORT_NUAGE, "127.0.0.1", ok));
await new Promise((ok) => serveurs[2].listen(PORT_PERSO, "127.0.0.1", ok));

writeFileSync(
  join(TMP, "profil.json"),
  JSON.stringify({
    chiffrement: "fichier",
    backends: [
      { id: "lmstudio", enabled: false },
      { id: "exo", enabled: true },
      { id: "nuage", label: "Nuage d'essai", baseUrl: `http://127.0.0.1:${PORT_NUAGE}/v1` },
    ],
  }),
);
const PORT = await portLibre();
const G = `http://127.0.0.1:${PORT}`;
const passerelle = spawn(process.execPath, [join(RACINE, "gateway", "src", "index.ts")], {
  env: {
    PATH,
    HOME: MAISON,
    LANG: "C",
    SHELL: "/bin/zsh",
    OXOAI_CONFIG: join(TMP, "profil.json"),
    OXOAI_DATA_DIR: DONNEES,
    OXOAI_GATEWAY_PORT: String(PORT),
    OXOAI_OPENCODE_BIN: OPENCODE,
    OXOAI_CODE_DIR: PROJET,
    OXOAI_LMSTUDIO_URL: "http://127.0.0.1:9/v1",
    OXOAI_EXO_URL: `http://127.0.0.1:${PORT_LOCAL}/v1`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let journal = "";
passerelle.stdout.on("data", (b) => (journal += b));
passerelle.stderr.on("data", (b) => (journal += b));

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

try {
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`${G}/health`);
      break;
    } catch {
      await attendre(250);
    }
  }
  const JETON = readFileSync(join(DONNEES, "instance-token"), "utf8").trim();
  const avecJeton = { "Content-Type": "application/json", Authorization: `Bearer ${JETON}` };
  const compte = await (await fetch(`${G}/oxoai/auth/create`, { method: "POST", headers: avecJeton, body: JSON.stringify({ fullName: "Essai RTK", email: "essai-rtk@example.test", password: "Essai2Rtk!Solide42" }) })).json();
  const avecSeance = { ...avecJeton, "X-OxoAI-Session": compte.session?.token ?? "" };
  const appel = (chemin, options = {}) => fetch(`${G}${chemin}`, { headers: avecSeance, ...options });
  const json = async (chemin, options) => (await appel(chemin, options)).json().catch(() => ({}));

  const ouvrir = async (modele) => (await json("/oxoai/code/session", { method: "POST", body: JSON.stringify({ model: modele, dossier: PROJET }) })).data?.id;
  console.log("\nInstallation de RTK par la passerelle");
  const premiere = await ouvrir("nuage-essai");
  let etat = {};
  for (let i = 0; i < 240; i++) {
    etat = (await json("/oxoai/code/rtk")).etat ?? {};
    if (etat.installe || etat.installation?.erreur) break;
    await attendre(500);
  }
  verifier("RTK 0.50.0 posé par la passerelle dans ses données (version épinglée, empreinte vérifiée)", etat.installe === true && existsSync(join(DONNEES, "rtk", "0.50.0", "rtk")), JSON.stringify(etat));
  const config = JSON.parse(readFileSync(join(DONNEES, "opencode", "opencode.json"), "utf8"));
  verifier("OpenCode lance ses commandes par l'enveloppe de OxoAI", config.shell === join(DONNEES, "rtk", "shell-code"), config.shell);

  /** Une demande, et la carte qu'elle fait naître : on la lit, on y répond. */
  const tour = async ({ modele, repere, rtk, accord = true, session }) => {
    const id = session ?? (await ouvrir(modele));
    const avant = RESULTATS.length;
    const envoi = appel("/oxoai/code/prompt", { method: "POST", body: JSON.stringify({ sessionID: id, text: `Lance la commande prévue. ${repere}`, model: modele, rtk }) }).then((r) => r.text());
    let carte;
    for (let i = 0; i < 120 && !carte; i++) {
      carte = ((await json("/oxoai/approbation")).enAttente ?? []).find((c) => c.detail?.surface === "code");
      if (!carte) await attendre(250);
    }
    if (carte) await appel("/oxoai/approbation/repondre", { method: "POST", body: JSON.stringify({ id: carte.id, accord }) });
    await envoi;
    for (let i = 0; i < 120 && RESULTATS.length === avant; i++) await attendre(250);
    // `OXOAI_ESSAI_BAVARD=1` : ce que le modèle a lu, pour le relever (PROJET.md).
    if (process.env.OXOAI_ESSAI_BAVARD) console.log(`    [${modele}, ${repere}, ${rtk ?? "cloud"}] ${JSON.stringify(RESULTATS.slice(avant).map((x) => x.contenu).join("\n"))}`);
    return { id, carte, resultat: RESULTATS.slice(avant).map((r) => r.contenu).join("\n") };
  };

  console.log("\nModèle cloud, réglage par défaut : RTK");
  const a = await tour({ modele: "nuage-essai", repere: "RTK-GIT", session: premiere });
  verifier("la carte d'accord montre la commande d'origine (« git status », pas « rtk git status »)", a.carte?.detail?.commande === "git status", JSON.stringify(a.carte?.detail ?? a.carte));
  verifier("la sortie lue par le modèle est celle de RTK (condensée, sans les phrases de git)", /\* main/.test(a.resultat) && !/Changes not staged|Untracked files|On branch/.test(a.resultat), a.resultat);
  const gain = await json(`/oxoai/code/rtk?sessionID=${a.id}`);
  verifier("jetons économisés mesurés par RTK pour cette session", gain.session?.actif === true && gain.session?.economies?.jetons > 0, JSON.stringify(gain.session));
  console.log(`    (${gain.session?.economies?.jetons} jetons économisés sur ${gain.session?.economies?.commandes} commande(s))`);

  const e = await tour({ modele: "nuage-essai", repere: "RTK-ECHO" });
  verifier("une commande que RTK ne connaît pas passe telle quelle", e.carte?.detail?.commande === "echo bonjour-rtk" && /bonjour-rtk/.test(e.resultat), `${e.carte?.detail?.commande} / ${e.resultat}`);

  const r = await tour({ modele: "nuage-essai", repere: "RTK-REFUS", accord: false });
  verifier("une commande refusée à la carte reste refusée avec RTK : rien n'est lancé", r.carte?.detail?.commande === "git status && touch temoin-refus.txt" && !existsSync(join(PROJET, "temoin-refus.txt")) && !/\* main/.test(r.resultat), `${r.carte?.detail?.commande} / ${r.resultat}`);

  console.log("\nRéglages");
  const j = await tour({ modele: "nuage-essai", repere: "RTK-GIT", rtk: "jamais" });
  verifier("« jamais » : sortie brute de git, même avec un modèle cloud", /Changes not staged|On branch/.test(j.resultat), j.resultat);
  const l = await tour({ modele: "local-essai", repere: "RTK-GIT" });
  verifier("modèle local, réglage par défaut (« cloud ») : sortie brute", /Changes not staged|On branch/.test(l.resultat), l.resultat);
  const tj = await tour({ modele: "local-essai", repere: "RTK-GIT", rtk: "toujours" });
  verifier("modèle local, « toujours » : RTK", /\* main/.test(tj.resultat) && !/Changes not staged/.test(tj.resultat), tj.resultat);

  /*
   * Revue du 28/09/2026 : la décision RTK demandait le modèle au routeur sans
   * dire pour qui, et le routeur écarte alors les modèles de clé personnelle ;
   * un tel modèle cloud partait sans RTK en réglage « cloud ».
   */
  console.log("\nModèle cloud d'une clé personnelle");
  const cle = await json("/oxoai/fournisseurs", {
    method: "POST",
    body: JSON.stringify({ fournisseur: "compatible", adresse: `http://127.0.0.1:${PORT_PERSO}/v1`, cle: "cle-essai-perso", nom: "Perso d'essai", modeles: ["perso-essai"], portee: "moi" }),
  });
  verifier("clé personnelle branchée (portée « moi »)", cle.cle?.portee === "moi", JSON.stringify(cle));
  const perso = await tour({ modele: "perso-essai", repere: "RTK-GIT" });
  verifier("modèle cloud d'une clé personnelle, réglage par défaut (« cloud ») : RTK", /\* main/.test(perso.resultat) && !/Changes not staged/.test(perso.resultat), perso.resultat);

  console.log("\nRepli sans RTK");
  // Gardé pour l'essai de télémétrie, plus bas.
  copyFileSync(join(DONNEES, "rtk", "0.50.0", "rtk"), RTK_COPIE);
  rmSync(join(DONNEES, "rtk", "0.50.0"), { recursive: true, force: true });
  const sans = await tour({ modele: "nuage-essai", repere: "RTK-GIT" });
  verifier("RTK retiré : la commande passe quand même, sortie brute", /Changes not staged|On branch/.test(sans.resultat), sans.resultat);
  await json(`/oxoai/code/rtk?sessionID=${sans.id}`);
  verifier("le repli est au journal de la passerelle", /\[rtk\] repli : .*RTK absent/.test(journal), journal.split("\n").filter((x) => x.includes("[rtk]")).join(" | "));
} finally {
  passerelle.kill("SIGTERM");
  for (const s of serveurs) s.close();
}

/*
 * Télémétrie : RTK n'envoie rien que si un consentement est écrit dans sa
 * configuration. On l'écrit, dans un dossier personnel jetable, puis on lance
 * RTK comme OxoAI (variable posée) et sans elle (témoin). La marque
 * `.telemetry_last_ping` est posée juste avant l'envoi (lu dans son code) :
 * elle dit si l'envoi aurait eu lieu. Réseau coupé pour le témoin.
 */
console.log("\nTélémétrie de RTK");
if (existsSync(RTK_COPIE)) {
  const rtk = join(TMP, "rtk-telemetrie");
  const pose = RTK_COPIE;
  mkdirSync(rtk);
  const maison = join(TMP, "maison-telemetrie");
  const dossierRtk = process.platform === "darwin" ? join(maison, "Library", "Application Support", "rtk") : join(maison, ".config", "rtk");
  const donneesRtk = process.platform === "darwin" ? dossierRtk : join(maison, ".local", "share", "rtk");
  mkdirSync(dossierRtk, { recursive: true });
  writeFileSync(join(dossierRtk, "config.toml"), "[telemetry]\nenabled = true\nconsent_given = true\n");
  const marque = join(donneesRtk, ".telemetry_last_ping");
  const lancer = (env) => {
    try {
      const base = ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)(deny network*)"];
      const [cmd, ...args] = existsSync(base[0]) ? [...base, pose, "git", "status"] : [pose, "git", "status"];
      execFileSync(cmd, args, { cwd: PROJET, env: { PATH, HOME: maison, RTK_DB_PATH: join(rtk, "h.db"), RTK_RECALL: "0", ...env }, stdio: "ignore", timeout: 20_000 });
    } catch {
      /* le code de sortie n'importe pas ici */
    }
  };
  lancer({ RTK_TELEMETRY_DISABLED: "1" });
  const avecVariable = existsSync(marque);
  lancer({});
  const temoin = existsSync(marque);
  verifier("consentement écrit, RTK_TELEMETRY_DISABLED=1 : aucun envoi préparé (témoin sans la variable, réseau coupé : envoi préparé)", !avecVariable && temoin, `avec variable ${avecVariable}, témoin ${temoin}`);
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${reussis} vérification(s) réussie(s), ${echecs.length} échec(s).`);
if (echecs.length) {
  console.log(journal.split("\n").filter((x) => /rtk|opencode|code\]/i.test(x)).slice(-40).join("\n"));
  process.exit(1);
}
