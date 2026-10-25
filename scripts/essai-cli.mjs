/*
 * Essai de la ligne de commande (cli/oxoai.mjs) contre une instance jetable.
 *
 *   npm run essai:cli                 sans modèle : connexion, séance, erreurs, listes, conversation
 *   npm run essai:cli -- --modele     avec le modèle de LM Studio : Chat, outils et accord, Code
 *
 * Comme la batterie de sécurité, il démarre une passerelle neuve sur un port
 * libre, avec des dossiers temporaires (données, projet, espace de Cowork) et
 * un fichier de séance temporaire : il ne touche ni à l'instance du poste, ni à
 * ~/.oxoai. Il se comporte ensuite comme quelqu'un au terminal. Les parties
 * interactives (mot de passe masqué, conversation, question d'accord, Ctrl+C)
 * passent par un vrai pseudo-terminal, ouvert par le module `pty` de Python :
 * sans Python 3, elles sont sautées, et l'essai le dit.
 *
 * Avec `--modele`, compter plusieurs minutes : un petit modèle local met de
 * dix secondes à deux minutes par réponse.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(RACINE, "cli", "oxoai.mjs");
const AVEC_MODELE = process.argv.includes("--modele");

const portLibre = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

const PORT = await portLibre();
const BANC = mkdtempSync(join(tmpdir(), "oxoai-essai-cli-"));
const DONNEES = join(BANC, "donnees");
const PROJET = join(BANC, "projet");
const ESPACE = join(BANC, "espace");
for (const d of [DONNEES, PROJET, ESPACE, join(BANC, "lume")]) mkdirSync(d, { recursive: true });
const G = `http://127.0.0.1:${PORT}`;
const SEANCE = join(BANC, "cli-seance");
const CONFIG = join(BANC, "oxoai.config.json");
writeFileSync(CONFIG, JSON.stringify({ connecteursLibres: true }));
const CARNET = join(BANC, "carnet.txt");
const TRACE = join(BANC, "trace-mcp.txt");

const passerelle = spawn(process.execPath, [join(RACINE, "gateway", "src", "index.ts")], {
  env: {
    ...process.env,
    OXOAI_GATEWAY_PORT: String(PORT),
    OXOAI_DATA_DIR: DONNEES,
    OXOAI_CODE_DIR: PROJET,
    OXOAI_WORKSPACE: ESPACE,
    OXOAI_LUME_DIR: join(BANC, "lume"),
    OXOAI_EXO_URL: "http://127.0.0.1:9/v1",
    ...(AVEC_MODELE ? {} : { OXOAI_LMSTUDIO_URL: "http://127.0.0.1:9/v1" }),
    // Commandes libres permises à cette instance jetable seulement : le connecteur d'essai (mcp-essai.mjs) n'est pas au catalogue.
    OXOAI_CONFIG: CONFIG,
    OXOAI_GATEWAY_HOST: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
  // Chef de son groupe : à la fin, on arrête d'un coup la passerelle et ce qu'elle a lancé (OpenCode).
  detached: true,
});
let journal = "";
passerelle.stdout.on("data", (b) => (journal += b));
passerelle.stderr.on("data", (b) => (journal += b));

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 80; i++) {
  try {
    await fetch(`${G}/health`);
    break;
  } catch {
    await attendre(250);
  }
}

let reussis = 0;
const echecs = [];
function verifier(nom, condition, obtenu) {
  if (condition) {
    reussis++;
    console.log(`  ✓ ${nom}`);
  } else {
    echecs.push(nom);
    console.log(`  ✗ ${nom}  —  obtenu : ${String(obtenu).slice(0, 600)}`);
  }
}

const JETON = readFileSync(join(DONNEES, "instance-token"), "utf8").trim();
const MOT_DE_PASSE = "Essai-CLI-2026!";
const EMAIL = "essai@example.test";
const ENV_CLI = {
  ...process.env,
  OXOAI_ADRESSE: G,
  OXOAI_DATA_DIR: DONNEES,
  OXOAI_CLI_SEANCE: SEANCE,
  NO_COLOR: "1",
};

/** La ligne de commande, sans terminal : entrée donnée d'avance. */
function cli(args, { entree = "", cwd = PROJET, env = {}, delai = 300_000 } = {}) {
  const debut = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    input: entree,
    env: { ...ENV_CLI, ...env },
    encoding: "utf8",
    timeout: delai,
  });
  return { code: r.status, sortie: r.stdout ?? "", erreur: r.stderr ?? "", ms: Date.now() - debut };
}

/** La même, en arrière-plan : pour répondre à une demande d'accord pendant qu'elle attend. */
function cliEnFond(args, { cwd = PROJET } = {}) {
  const p = spawn(process.execPath, [CLI, ...args], { cwd, env: ENV_CLI, stdio: ["pipe", "pipe", "pipe"] });
  let sortie = "";
  p.stdout.on("data", (b) => (sortie += b));
  p.stderr.on("data", (b) => (sortie += b));
  p.stdin.end();
  const debut = Date.now();
  const fin = new Promise((ok) => p.on("close", (code) => ok({ code, sortie, ms: Date.now() - debut })));
  return { fin, sortie: () => sortie };
}

/*
 * Pseudo-terminal : un petit programme Python qui lance la commande dans un
 * vrai terminal, attend chaque texte prévu et envoie la touche ou la ligne
 * correspondante. Il rend la transcription entière.
 */
const PTY = String.raw`
import json, os, pty, re, select, sys, time
args = json.loads(sys.argv[1]); etapes = json.loads(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(args[0], args)
tout = b""; ok = True; manque = None; depuis = 0
def lire(jusqua):
    global tout
    while time.time() < jusqua:
        r, _, _ = select.select([fd], [], [], 0.2)
        if fd in r:
            try:
                b = os.read(fd, 4096)
            except OSError:
                return False
            if not b:
                return False
            tout += b
        yield
# Chaque étape cherche son texte dans ce qui est arrivé APRÈS la précédente.
def chercher(attendu):
    global depuis
    texte = tout.decode("utf8", "replace")
    m = re.search(attendu, texte[depuis:])
    if m:
        depuis += m.end()
        return True
    return False
for attendu, envoyer, delai in etapes:
    fin = time.time() + delai
    trouve = chercher(attendu)
    if not trouve:
        for _ in lire(fin):
            if chercher(attendu):
                trouve = True
                break
    if not trouve:
        ok = False; manque = attendu; break
    if envoyer:
        os.write(fd, envoyer.encode("utf8"))
fin = time.time() + 15
for _ in lire(fin):
    pass
try:
    os.kill(pid, 9)
except Exception:
    pass
print(json.dumps({"ok": ok, "manque": manque, "sortie": tout.decode("utf8", "replace")}))
`;
const PYTHON = spawnSync("python3", ["-c", "import pty"], { encoding: "utf8" }).status === 0;

function terminal(args, etapes, { cwd = PROJET } = {}) {
  const commande = ["/usr/bin/env", ...Object.entries({ ...ENV_CLI, TERM: "dumb" }).filter(([k]) => /^(OXOAI_|NO_COLOR|TERM|PATH|HOME)/.test(k)).map(([k, v]) => `${k}=${v}`), process.execPath, CLI, ...args];
  const r = spawnSync("python3", ["-c", PTY, JSON.stringify(commande), JSON.stringify(etapes)], {
    cwd,
    encoding: "utf8",
    timeout: 600_000,
  });
  try {
    return JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {
    return { ok: false, manque: "sortie illisible", sortie: `${r.stdout}\n${r.stderr}` };
  }
}

const api = (chemin, { methode = "GET", corps, seance } = {}) =>
  fetch(`${G}${chemin}`, {
    method: methode,
    headers: {
      Authorization: `Bearer ${JETON}`,
      "Content-Type": "application/json",
      ...(seance ? { "X-OxoAI-Session": seance } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });

try {
  /* ----------------------------------------------------------------------- */
  console.log("\n1. Sans compte, sans séance, sans instance");
  {
    const r = cli(["aide"]);
    verifier("« oxoai aide » décrit les commandes", r.code === 0 && /oxoai code/.test(r.sortie) && /--adresse/.test(r.sortie), r.sortie);
    verifier("aucun tiret cadratin dans l'aide", !r.sortie.includes("\u2014"), r.sortie);
  }
  {
    const port = await portLibre();
    // Un jeton donné : celui du poste n'est lu que pour le port que l'application a ouvert (instance-port).
    const r = cli(["modeles"], { env: { OXOAI_ADRESSE: `http://127.0.0.1:${port}`, OXOAI_JETON: "jeton-d-essai" } });
    verifier("instance injoignable : le dit, et dit d'ouvrir l'application", r.code === 1 && /ne répond pas/.test(r.erreur) && /Ouvrez l'application/.test(r.erreur), r.erreur);
  }
  {
    const r = cli(["modeles"], { env: { OXOAI_ADRESSE: "http://instance.example.test" } });
    verifier("http vers une autre machine : refusé avant tout envoi", r.code === 1 && /en http/.test(r.erreur), r.erreur);
  }
  {
    const r = cli(["modeles"], { env: { OXOAI_JETON: "faux-jeton-de-la-bonne-longueur-xx" } });
    verifier("jeton d'instance faux : dit que c'est le jeton", r.code === 1 && /refuse ce jeton/.test(r.erreur), r.erreur);
  }
  {
    const r = cli(["modeles"], { env: { OXOAI_DATA_DIR: join(BANC, "inexistant") } });
    verifier("pas de jeton sur le poste : dit quoi faire", r.code === 1 && /Aucun jeton d'instance/.test(r.erreur), r.erreur);
  }
  {
    const r = cli(["connexion"]);
    verifier("connexion sans aucun compte : le dit", r.code === 1 && /Aucun compte/.test(r.erreur), r.erreur);
  }

  const creation = await api("/oxoai/auth/create", {
    methode: "POST",
    corps: { fullName: "Essai CLI", email: EMAIL, password: MOT_DE_PASSE },
  });
  verifier("compte d'essai créé par l'API", creation.ok, creation.status);

  {
    const r = cli(["code", "écris un fichier"]);
    verifier("Code sans séance : demande de se connecter", r.code === 1 && /oxoai connexion/.test(r.erreur), r.erreur);
    const o = cli(["chat", "--outils", "liste mes fichiers"]);
    verifier("Chat avec outils sans séance : demande de se connecter", o.code === 1 && /oxoai connexion/.test(o.erreur), o.erreur);
  }

  /* ----------------------------------------------------------------------- */
  console.log("\n2. Connexion et séance");
  {
    const r = cli(["connexion", "--compte", EMAIL], { entree: "mauvais-mot-de-passe\n" });
    verifier("mauvais mot de passe : refusé, rien d'écrit", r.code === 1 && !existsSync(SEANCE), `${r.code} ${r.erreur}`);
  }
  {
    const r = cli(["connexion", "--compte", "personne@example.test"], { entree: `${MOT_DE_PASSE}\n` });
    verifier("compte inconnu : le dit", r.code === 1 && /Aucun compte ne correspond/.test(r.erreur), r.erreur);
  }
  let seance = "";
  {
    const r = cli(["connexion", "--compte", EMAIL], { entree: `${MOT_DE_PASSE}\n` });
    verifier("bon mot de passe : connecté", r.code === 0 && /Connecté/.test(r.sortie), `${r.sortie} ${r.erreur}`);
    const mode = existsSync(SEANCE) ? statSync(SEANCE).mode & 0o777 : -1;
    verifier("fichier de séance en 0600", mode === 0o600, mode.toString(8));
    const contenu = existsSync(SEANCE) ? readFileSync(SEANCE, "utf8") : "";
    verifier("le mot de passe n'est pas dans le fichier de séance", contenu && !contenu.includes(MOT_DE_PASSE), contenu);
    seance = JSON.parse(contenu || "{}")?.instances?.[G]?.seance ?? "";
    verifier("la séance est rangée sous l'adresse de l'instance", Boolean(seance), contenu);
    const moi = await api("/oxoai/approbation", { seance });
    verifier("la séance enregistrée est acceptée par l'instance", moi.ok, moi.status);
  }
  {
    const r = cli(["modeles"], { env: { OXOAI_ADRESSE: `http://localhost:${PORT}` } });
    verifier("la séance n'est envoyée qu'à l'adresse qui l'a ouverte", r.code === 0 || /Aucun modèle|Modèles/.test(r.sortie + r.erreur), r.erreur);
  }

  /* ----------------------------------------------------------------------- */
  console.log("\n3. Listes");
  {
    const r = cli(["outils"]);
    verifier("« oxoai outils » liste les groupes et le niveau d'accord", r.code === 0 && /Fichiers/.test(r.sortie) && /Accord demandé : avant chaque modification/.test(r.sortie), r.sortie + r.erreur);
    const m = cli(["modeles"]);
    verifier("« oxoai modeles » répond", m.code === 0 && (AVEC_MODELE ? /Modèles de l'instance/.test(m.sortie) : /Aucun modèle|Modèles/.test(m.sortie)), m.sortie + m.erreur);
  }

  /* ----------------------------------------------------------------------- */
  console.log("\n4. Au terminal (pseudo-terminal)");
  if (!PYTHON) {
    console.log("  (sauté : python3 absent, pas de pseudo-terminal)");
  } else {
    const secret = "Mot-De-Passe-Pty-9876!";
    // Un second compte ne s'ouvre qu'avec la séance d'un collègue (ou une invitation).
    const second = await api("/oxoai/auth/create", { methode: "POST", seance, corps: { fullName: "Pty", email: "pty@example.test", password: secret } });
    verifier("second compte créé par un collègue connecté", second.ok, second.status);
    const seanceAvant = readFileSync(SEANCE, "utf8");
    const t = terminal(["connexion", "--compte", "pty@example.test"], [
      ["Mot de passe de Pty", `${secret}\r`, 20],
      // Un compte créé par un collègue choisit d'abord son propre mot de passe (règle de l'instance) : le terminal le dit.
      ["Choisissez votre propre mot de passe", "", 20],
    ]);
    verifier("connexion au terminal : un compte créé par un collègue est invité à choisir son propre mot de passe", t.ok, t.manque + "\n" + t.sortie);
    verifier("le mot de passe tapé ne s'affiche pas", !t.sortie.includes(secret), t.sortie);
    // On revient sur le compte principal pour la suite.
    writeFileSync(SEANCE, seanceAvant, { mode: 0o600 });

    const c = terminal(["chat"], [
      ["vous ›", "/modele\r", 20],
      ["Modèle :", "", 20],
      ["vous ›", "/nouveau\r", 20],
      ["Nouveau Chat", "", 10],
      ["vous ›", "/quitter\r", 10],
      ["À bientôt", "", 10],
    ]);
    verifier("conversation : /modele, /nouveau, /quitter", c.ok, c.manque + "\n" + c.sortie);
    const d = terminal(["chat"], [["vous ›", "\u0004", 20], ["À bientôt", "", 10]]);
    verifier("Ctrl+D au repos : sortie propre", d.ok, d.manque + "\n" + d.sortie);
    const e = terminal(["chat"], [["vous ›", "\u0003", 20], ["À bientôt", "", 10]]);
    verifier("Ctrl+C au repos : sortie propre", e.ok, e.manque + "\n" + e.sortie);
  }

  /* ----------------------------------------------------------------------- */
  if (AVEC_MODELE) {
    console.log("\n5. Avec le modèle");
    {
      const r = cli(["chat", "Réponds en un seul mot : quelle est la capitale de la France ?"]);
      verifier(`Chat : une réponse (${Math.round(r.ms / 1000)} s)`, r.code === 0 && /Paris/i.test(r.sortie), r.sortie + r.erreur);
    }
    {
      // Refus donné par l'API pendant que la ligne de commande attend, sans terminal.
      const cible = join(ESPACE, "refus.txt");
      const p = cliEnFond(["chat", "--outils", `Écris le fichier ${cible} avec le contenu « non ». Utilise l'outil d'écriture.`]);
      let demande = null;
      for (let i = 0; i < 240 && !demande; i++) {
        await attendre(1000);
        const r = await api("/oxoai/approbation", { seance });
        demande = r.ok ? (await r.json()).enAttente?.[0] : null;
      }
      verifier("Chat avec outils : l'écriture attend un accord", Boolean(demande), p.sortie());
      if (demande) {
        await attendre(1500);
        verifier("sans terminal, la ligne de commande dit de répondre dans l'application", /répondez dans l'application/.test(p.sortie()), p.sortie());
        await api("/oxoai/approbation/repondre", { methode: "POST", seance, corps: { id: demande.id, accord: false } });
      }
      const r = await p.fin;
      verifier(`refusée : le fichier n'est pas écrit (${Math.round(r.ms / 1000)} s)`, !existsSync(cible), r.sortie);
    }
    if (PYTHON) {
      // Accord donné à la ligne de commande elle-même, au terminal.
      const cible = join(ESPACE, "accord.txt");
      const t = terminal(["chat", "--outils", `Écris le fichier ${cible} avec exactement le contenu « oui ». Utilise l'outil d'écriture.`], [
        ["Autoriser \\? \\[o/N\\]", "o\r", 300],
        ["Accordé", "", 20],
        ["\\S", "", 300],
      ]);
      await attendre(2000);
      verifier("Chat avec outils : la question d'accord s'affiche au terminal, « o » accorde", t.ok, t.manque + "\n" + t.sortie);
      verifier("accordée : le fichier est écrit", existsSync(cible), t.sortie);
      verifier("la ligne « ✓ Écriture … » s'affiche", /✓ Écriture/.test(t.sortie), t.sortie);
    }
    {
      /*
       * Depuis le 26/09/2026, une écriture de l'agent de code attend un accord
       * au niveau « Demander avant de modifier » (permissionsCode.ts) : sans
       * terminal, la ligne de commande ne répond pas, on accorde par l'API.
       */
      const p = cliEnFond(["code", "Crée le fichier bonjour.txt contenant exactement la ligne : Bonjour depuis le terminal"]);
      let demande = null;
      for (let i = 0; i < 300 && !demande; i++) {
        await attendre(1000);
        const e = await api("/oxoai/approbation", { seance });
        demande = e.ok ? ((await e.json()).enAttente ?? []).find((d) => d.detail?.surface === "code") : null;
      }
      verifier("Code : l'écriture de l'agent de code attend un accord (carte « code »)", /^code__(write|edit|apply_patch)$/.test(demande?.detail?.outil ?? ""), JSON.stringify(demande) + p.sortie());
      if (demande) await api("/oxoai/approbation/repondre", { methode: "POST", seance, corps: { id: demande.id, accord: true } });
      const r = await p.fin;
      const fichier = join(PROJET, "bonjour.txt");
      const contenu = existsSync(fichier) ? readFileSync(fichier, "utf8") : "";
      verifier(`Code : bonjour.txt écrit dans le dossier courant (${Math.round(r.ms / 1000)} s)`, /Bonjour depuis le terminal/.test(contenu), r.sortie + r.erreur);
      verifier("Code : l'action s'affiche (« ✓ Écriture bonjour.txt »)", /✓ Écriture bonjour\.txt/.test(r.sortie), r.sortie);
    }
    /*
     * Un connecteur MCP dans OxoAI Code (ajouté le 25/09/2026) : le serveur
     * d'essai scripts/mcp-essai.mjs, sans compte. La trace qu'il écrit prouve
     * de l'extérieur si l'outil a été exécuté ou non.
     */
    const lire = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
    {
      const ajout = await api("/oxoai/connecteurs/ajouter", {
        methode: "POST",
        seance,
        corps: { id: "carnet", label: "Carnet d'essai", command: process.execPath, args: [join(RACINE, "scripts", "mcp-essai.mjs"), CARNET, TRACE] },
      });
      verifier("connecteur MCP d'essai ajouté", ajout.ok, await ajout.text());
      const p = cliEnFond(["code", "Ajoute la note « réunion jeudi » dans le carnet de l'équipe. Utilise l'outil carnet prévu pour cela, pas un fichier."]);
      let demande = null;
      for (let i = 0; i < 300 && !demande; i++) {
        await attendre(1000);
        const r = await api("/oxoai/approbation", { seance });
        demande = r.ok ? ((await r.json()).enAttente ?? []).find((d) => d.detail?.outil === "carnet__noter") : null;
      }
      verifier("Code : l'outil du connecteur demande un accord, à la personne qui a envoyé la demande", demande?.detail?.outil === "carnet__noter", JSON.stringify(demande) + p.sortie());
      if (demande) await api("/oxoai/approbation/repondre", { methode: "POST", seance, corps: { id: demande.id, accord: false } });
      const r = await p.fin;
      verifier(`Code : refusé, l'outil n'est pas exécuté (${Math.round(r.ms / 1000)} s)`, !/noter/.test(lire(TRACE)), lire(TRACE) + r.sortie);
      verifier("Code : le refus s'affiche (« ✗ Connecteur carnet »)", /✗ Connecteur carnet/.test(r.sortie), r.sortie);
    }
    if (PYTHON) {
      const t = terminal(["code", "Note dans le carnet de l'équipe : livraison vendredi. Utilise l'outil carnet prévu pour cela, pas un fichier."], [
        ["Autoriser \\? \\[o/N\\]", "o\r", 400],
        ["Accordé", "", 20],
        ["✓ Connecteur carnet", "", 120],
      ]);
      // spawnSync a bloqué ce processus : on laisse passer la fermeture des connexions gardées ouvertes.
      await attendre(300);
      verifier("Code : la question d'accord s'affiche au terminal, « o » accorde, « ✓ Connecteur carnet »", t.ok, t.manque + "\n" + t.sortie);
      verifier("Code : accordé, l'outil du connecteur est exécuté", /noter .*livraison vendredi/i.test(lire(TRACE)) && /livraison vendredi/i.test(lire(CARNET)), lire(TRACE));
      const journalAudit = readdirSync(join(DONNEES, "audit")).filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(join(DONNEES, "audit", f), "utf8")).join("");
      verifier("Code : l'appel est au journal (outil.appele, surface « code »)", /"action":"outil\.appele"[^\n]*"outil":"carnet__noter"[^\n]*"surface":"code"/.test(journalAudit), journalAudit.slice(-600));
    }
    if (PYTHON) {
      const t = terminal(["code"], [
        ["code ›", "Écris un long poème de cinquante strophes dans poeme.md, strophe par strophe.\r", 60],
        ["", "", 8],
        ["\\S", "\u0003", 5],
        ["Arrêt demandé à l'agent", "", 30],
        ["code ›", "/quitter\r", 30],
        ["À bientôt", "", 10],
      ]);
      verifier("Code : Ctrl+C arrête l'agent et rend la main", t.ok, t.manque + "\n" + t.sortie);
    }
  }

  /* ----------------------------------------------------------------------- */
  /*
   * La réflexion laissée dans le texte par un moteur qui ne la sépare pas
   * (29/09/2026) : un faux point d'accès compatible à la place de l'instance
   * envoie `<think>…</think>` (balises coupées) ou `</think>` seul. La
   * réponse s'écrit sans balise ni réflexion ; déjà écrite, une réflexion
   * requalifiée est dite.
   */
  console.log("\n5 bis. Réflexion écrite dans le texte");
  {
    const { createServer: serveurHttp } = await import("node:http");
    const FORMES = {
      "balises-essai": ["<thi", "nk>\nJe réfléchis", " encore.</th", "ink>\n\nBonjour ", "depuis le faux modèle."],
      "fermante-essai": ["Je réfléchis", " encore.\n</think>", "\n\nBonjour ", "depuis le faux modèle."],
    };
    const faux = serveurHttp((req, res) => {
      let corps = "";
      req.on("data", (b) => (corps += b));
      req.on("end", () => {
        const derniere = String(JSON.parse(corps || "{}").messages?.at(-1)?.content ?? "");
        const forme = Object.keys(FORMES).find((f) => derniere.includes(f)) ?? "balises-essai";
        res.setHeader("Content-Type", "text/event-stream");
        for (const m of FORMES[forme]) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: m } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    const portFaux = await portLibre();
    await new Promise((ok) => faux.listen(portFaux, "127.0.0.1", ok));
    try {
      const balises = await cliEnFond(["chat", "--adresse", `http://127.0.0.1:${portFaux}`, "--jeton", "essai", "Dis bonjour balises-essai"]).fin;
      verifier("réflexion entre balises coupées : seule la réponse s'écrit, sans balise ni réflexion", balises.code === 0 && /Bonjour depuis le faux modèle\./.test(balises.sortie) && !/think>|réfléchis/.test(balises.sortie), balises.sortie);
      const fermante = await cliEnFond(["chat", "--adresse", `http://127.0.0.1:${portFaux}`, "--jeton", "essai", "Dis bonjour fermante-essai"]).fin;
      verifier("</think> seul : la balise ne s'écrit pas, ce qui précède est dit comme la réflexion, puis la réponse", fermante.code === 0 && /Bonjour depuis le faux modèle\./.test(fermante.sortie) && !/think>/.test(fermante.sortie) && /ce qui précède était la réflexion du modèle/.test(fermante.sortie), fermante.sortie);
    } finally {
      faux.close();
    }
  }

  /* ----------------------------------------------------------------------- */
  console.log("\n6. Déconnexion");
  {
    const r = cli(["deconnexion"]);
    verifier("déconnexion : fermée sur l'instance", r.code === 0 && /fermée sur l'instance/.test(r.sortie), r.sortie + r.erreur);
    const apres = await api("/oxoai/approbation", { seance });
    verifier("l'ancienne séance ne vaut plus rien", apres.status === 401, apres.status);
    const f = existsSync(SEANCE) ? readFileSync(SEANCE, "utf8") : "";
    verifier("la séance n'est plus dans le fichier", !f.includes(seance), f);
    const c = cli(["code", "x"]);
    verifier("après déconnexion, Code redemande une connexion", c.code === 1 && /oxoai connexion/.test(c.erreur), c.erreur);
  }
  {
    writeFileSync(SEANCE, "{ illisible", { mode: 0o600 });
    const r = cli(["connexion", "--compte", EMAIL], { entree: `${MOT_DE_PASSE}\n` });
    verifier("fichier de séance illisible : pas réécrit par-dessus", r.code === 1 && readFileSync(SEANCE, "utf8") === "{ illisible", r.erreur);
    rmSync(SEANCE, { force: true });
  }
} catch (err) {
  // Une exception n'est pas un succès : elle compte comme un échec, avec la fin du journal de la passerelle.
  verifier("l'essai va jusqu'au bout sans exception", false, `${err?.stack ?? err}\n--- passerelle ---\n${journal.slice(-3000)}`);
} finally {
  try {
    process.kill(-passerelle.pid, "SIGTERM");
  } catch {
    passerelle.kill("SIGTERM");
  }
  await attendre(1000);
  try {
    process.kill(-passerelle.pid, "SIGKILL");
  } catch {
    /* déjà arrêtés */
  }
  rmSync(BANC, { recursive: true, force: true });
}

console.log(`\n${reussis} réussis, ${echecs.length} échoués.`);
if (echecs.length) {
  if (process.env.OXOAI_ESSAI_JOURNAL) console.log(journal.slice(-4000));
  process.exit(1);
}
