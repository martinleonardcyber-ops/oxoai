/*
 * La passerelle dans un `utilityProcess`, lancée par electron/passerelle.cjs
 * tel que l'application s'en sert (fusible RunAsNode fermé le 28/09/2026,
 * SECURITE.md, « RunAsNode fermé »). Lancé par scripts/securite.mjs avec le
 * binaire d'Electron du projet, jamais l'application installée : aucune
 * fenêtre, aucun trousseau (profil `chiffrement: fichier`), un dossier de
 * données et un port jetables. Rend une ligne JSON.
 *
 * Ce qui est mesuré :
 *  - la passerelle démarre et répond sur /health ;
 *  - le canal marche dans les deux sens : la demande `node-prive` reçoit sa
 *    réponse (un faux Node de OxoAI est déjà posé dans le dossier jetable,
 *    rien n'est téléchargé) ;
 *  - SIGUSR1 n'ouvre pas le débogueur (port 9229), alors que le binaire
 *    d'Electron du projet a le fusible --inspect ouvert : c'est l'écoute du
 *    signal par la passerelle qui le ferme, pas le fusible ;
 *  - l'arrêt (SIGTERM hors de Windows) passe par son gestionnaire : code 0,
 *    port libéré.
 */
const { app } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const [RACINE, ENTREE, DONNEES, PORT, PROFIL] = process.argv.slice(-5);
const profilElectron = fs.mkdtempSync(path.join(os.tmpdir(), "oxoai-passerelle-profil-"));
app.setPath("userData", profilElectron);
if (app.dock) app.dock.hide();

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const sante = () =>
  new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: Number(PORT), path: "/health", timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
const ecoute = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });

app.whenReady().then(async () => {
  const resultat = {};
  const fin = () => {
    console.log(JSON.stringify(resultat));
    fs.rmSync(profilElectron, { recursive: true, force: true });
    app.exit(0);
  };
  setTimeout(() => {
    resultat.plantage = "délai dépassé";
    fin();
  }, 90_000).unref();
  try {
    const { lancerPasserelle, envoyerALaPasserelle, arreterPasserelle } = require(path.join(RACINE, "electron", "passerelle.cjs"));
    const enfant = lancerPasserelle({
      entry: ENTREE,
      nom: "Essai",
      env: {
        ...process.env,
        // Comme depuis le terminal de VS Code : la variable ne doit rien changer.
        ELECTRON_RUN_AS_NODE: "1",
        OXOAI_CONFIG: PROFIL,
        OXOAI_DATA_DIR: DONNEES,
        OXOAI_GATEWAY_PORT: PORT,
        OXOAI_GATEWAY_HOST: "127.0.0.1",
        OXOAI_LMSTUDIO_URL: "http://127.0.0.1:9/v1",
        OXOAI_EXO_URL: "http://127.0.0.1:9/v1",
      },
    });
    let journal = "";
    enfant.stdout?.on("data", (b) => (journal += b));
    enfant.stderr?.on("data", (b) => (journal += b));
    const reponses = [];
    enfant.on("message", (m) => reponses.push(m));

    let pret = false;
    for (let i = 0; i < 120 && !pret; i++) {
      pret = await sante();
      if (!pret) await attendre(250);
    }
    resultat.repond = pret;
    resultat.pid = enfant.pid ?? null;
    if (!pret) {
      resultat.journal = journal.slice(-600);
      await arreterPasserelle(enfant);
      return fin();
    }

    envoyerALaPasserelle(enfant, { type: "node-prive", id: 7 });
    for (let i = 0; i < 40 && !reponses.some((m) => m?.type === "node-prive"); i++) await attendre(100);
    resultat.canal = reponses.find((m) => m?.type === "node-prive") ?? null;

    resultat.debogueurAvant = await ecoute(9229);
    if (process.platform !== "win32" && enfant.pid) {
      process.kill(enfant.pid, "SIGUSR1");
      await attendre(1500);
      resultat.debogueurApres = await ecoute(9229);
      resultat.repondApresSignal = await sante();
      resultat.signalNote = journal.includes("SIGUSR1 reçu et ignoré");
    }

    const depart = Date.now();
    const code = await new Promise((resolve) => {
      enfant.once("exit", (c) => resolve(c));
      void arreterPasserelle(enfant);
      setTimeout(() => resolve("délai"), 8000).unref();
    });
    resultat.arret = { code, ms: Date.now() - depart, portLibre: !(await ecoute(Number(PORT))) };
  } catch (err) {
    resultat.plantage = String(err?.stack ?? err).slice(0, 400);
  }
  fin();
});
