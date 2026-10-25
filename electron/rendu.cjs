/**
 * Banc d'essai des pages écrites par OxoAI Code : la page est vraiment ouverte,
 * dans une fenêtre cachée, et on relève ce qu'un humain verrait en premier.
 *
 * Demandé par Medhi le 26/09/2026, après l'ERP d'essai : « le petit modèle doit
 * produire un bon niveau de logiciel ». L'agent avait annoncé une application
 * « fonctionnelle » dont le script ne compilait pas ; corrigée, elle s'ouvrait
 * sur une page blanche (aucun onglet actif), avec des onglets blanc sur gris,
 * et ses listes ne se mettaient pas à jour. Le contrôle statique
 * (gateway/src/controleWeb.ts) voit la syntaxe et les liens ; seul un vrai
 * navigateur voit le reste. La passerelle n'en a pas (elle tourne en Node) :
 * l'application lui prête le sien, par un petit serveur sur la boucle locale,
 * fermé par une clé tirée au sort et passée à la passerelle seule.
 *
 * Ce qui est relevé, sans rien juger à la place de l'agent :
 *  - les erreurs de la console et les ressources qui ne se chargent pas ;
 *  - une page qui s'ouvre (presque) vide ;
 *  - un texte illisible (contraste inférieur à 3 sur son fond) ;
 *  - les boutons et formulaires essayés un par un avec des valeurs d'exemple :
 *    une erreur qu'ils déclenchent, ou un formulaire envoyé sans que rien ne
 *    change à l'écran.
 * La fenêtre est isolée (session en mémoire, bac à sable, sans Node), les
 * boîtes de dialogue sont neutralisées, et elle est détruite après l'essai.
 *
 * La page n'est plus ouverte en `file://` (revue de sécurité du 26/09/2026) :
 * l'application garde à ces pages le droit Electron de lire les autres
 * fichiers du disque (fusible GrantFileProtocolExtraPrivileges), et une page
 * écrite par un modèle, ou le script d'un CDN qu'elle charge, aurait pu lire
 * ~/.oxoai puis l'envoyer au dehors. Elle est servie par un serveur éphémère
 * sur la boucle locale, qui ne sert que le dossier du projet (chemins réels,
 * liens symboliques compris) ; sous `http://127.0.0.1`, le navigateur refuse
 * tout `file://`. Les permissions (caméra, micro, notifications…) sont
 * refusées d'office.
 */

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { BrowserWindow, session } = require("electron");
const { demarrerFiltre } = require("./filtreReseau.cjs");

const ATTENTE_CHARGEMENT_MS = 2500;
const DUREE_MAX_MS = 25_000;

/** Le script d'analyse, exécuté dans la page après son chargement. */
const ANALYSE = String.raw`(async () => {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  window.alert = () => {}; window.confirm = () => true; window.prompt = () => "Exemple";
  const erreurs = [];
  window.addEventListener("error", (e) => erreurs.push(String(e.message || e.error || "erreur")));
  window.addEventListener("unhandledrejection", (e) => erreurs.push("Promesse rejetée : " + String(e.reason)));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const texteVisible = () => {
    let t = "";
    const marche = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (marche.nextNode()) {
      const n = marche.currentNode;
      if (n.parentElement && visible(n.parentElement) && n.textContent.trim()) t += n.textContent.trim() + " ";
    }
    return t.trim();
  };
  const rvb = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = "1"] = m[1].split(",").map((x) => x.trim()); return { r: +r, g: +g, b: +b, a: +a }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const fond = (el) => { for (let e = el; e; e = e.parentElement) { const c = rvb(getComputedStyle(e).backgroundColor); if (c && c.a > 0.5) return c; } return { r: 255, g: 255, b: 255 }; };
  const illisibles = [];
  for (const el of document.querySelectorAll("body *")) {
    if (illisibles.length >= 6) break;
    const propre = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!propre || !visible(el)) continue;
    const c = rvb(getComputedStyle(el).color); if (!c) continue;
    const a = lum(c), b = lum(fond(el));
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < 3) illisibles.push({ texte: el.textContent.trim().slice(0, 40), balise: el.tagName.toLowerCase(), contraste: Math.round(ratio * 10) / 10 });
  }
  const auChargement = texteVisible();
  const essais = [];
  // Boutons hors formulaire (onglets, actions) : un clic chacun.
  const boutons = [...document.querySelectorAll("button, [onclick], [role=tab]")].filter((b) => !b.closest("form") && visible(b)).slice(0, 12);
  for (const b of boutons) {
    const avant = erreurs.length;
    try { b.click(); } catch (e) { erreurs.push(String(e && e.message)); }
    await pause(150);
    if (erreurs.length > avant) essais.push({ quoi: "bouton « " + (b.textContent || "").trim().slice(0, 30) + " »", probleme: erreurs.slice(avant).join(" ; ").slice(0, 200) });
  }
  // Formulaires : remplis avec des valeurs d'exemple, puis envoyés ; l'écran doit changer.
  const exemple = (i) => { const t = (i.type || "text").toLowerCase(); if (t === "email") return "exemple@exemple.fr"; if (t === "number") return "42"; if (t === "date") return "2026-09-26"; if (t === "tel") return "0600000000"; if (t === "url") return "https://exemple.fr"; return "Exemple " + (i.name || i.id || "texte"); };
  for (const f of [...document.forms].slice(0, 8)) {
    // Le formulaire doit être visible : on ouvre d'abord la section qui le contient, par ses propres boutons s'il le faut.
    if (!visible(f)) { for (const b of boutons) { b.click(); await pause(120); if (visible(f)) break; } }
    if (!visible(f)) continue;
    for (const i of f.querySelectorAll("input, textarea")) {
      if (["submit", "button", "hidden", "checkbox", "radio", "file"].includes((i.type || "").toLowerCase())) continue;
      i.value = exemple(i); i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const vides = [...f.querySelectorAll("select")].filter((s) => s.options.length === 0 && visible(s));
    const avant = texteVisible(); const nbErr = erreurs.length;
    try { f.requestSubmit ? f.requestSubmit() : f.submit(); } catch (e) { erreurs.push(String(e && e.message)); }
    await pause(300);
    const nom = (f.querySelector("button, [type=submit]")?.textContent || f.id || "formulaire").trim().slice(0, 30);
    if (erreurs.length > nbErr) essais.push({ quoi: "formulaire « " + nom + " »", probleme: erreurs.slice(nbErr).join(" ; ").slice(0, 200) });
    else if (texteVisible() === avant) essais.push({ quoi: "formulaire « " + nom + " »", probleme: vides.length ? "une liste déroulante est vide : impossible de choisir, et rien ne change à l'envoi" : "rempli et envoyé, rien ne change à l'écran" });
  }
  return { texteAuChargement: auChargement.length, extrait: auChargement.slice(0, 120), illisibles, essais, erreurs };
})()`;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".wasm": "application/wasm",
};

/**
 * Sert le dossier `racine`, et rien d'autre, le temps d'un essai. Un chemin
 * qui en sort (`..`, lien symbolique vers ailleurs) reçoit un 404.
 */
function servirDossier(racine) {
  const reelle = fs.realpathSync(racine);
  const serveur = http.createServer((req, res) => {
    const refuser = () => { res.writeHead(404); res.end(); };
    if (req.method !== "GET" && req.method !== "HEAD") return refuser();
    let chemin;
    try {
      chemin = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      return refuser();
    }
    let cible;
    try {
      cible = fs.realpathSync(path.join(reelle, chemin));
    } catch {
      return refuser();
    }
    if (cible !== reelle && !cible.startsWith(reelle + path.sep)) return refuser();
    /*
     * Ni fichier ni dossier caché (test d'intrusion du 27/09/2026) : `.env`,
     * `.git/config`, `.npmrc` se lisaient par un simple fetch depuis la page à
     * l'essai, qui est de la même origine, et donc par n'importe quel script
     * de CDN qu'elle charge. Ouverte à la main depuis le disque, la même page
     * ne les lit pas. Le chemin résolu compte : un lien `a.txt → .env` aussi.
     */
    if (path.relative(reelle, cible).split(path.sep).some((s) => s.startsWith("."))) return refuser();
    let info;
    try {
      info = fs.statSync(cible);
    } catch {
      return refuser();
    }
    if (info.isDirectory()) {
      const index = path.join(cible, "index.html");
      if (!fs.existsSync(index)) return refuser();
      cible = index;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(cible).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(cible).on("error", () => res.destroy()).pipe(res);
  });
  return new Promise((resolve, reject) => {
    serveur.once("error", reject);
    serveur.listen(0, "127.0.0.1", () => resolve({ serveur, origine: `http://127.0.0.1:${serveur.address().port}`, reelle }));
  });
}

/** Ouvre la page, attend, analyse. Rend le rapport, jamais d'exception. */
async function rendre(fichier, racine) {
  const partition = `rendu-${crypto.randomBytes(6).toString("hex")}`;
  const ses = session.fromPartition(partition, { cache: false });
  const fenetre = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  const console_ = [];
  const echecs = [];
  // Ni caméra, ni micro, ni notifications, ni presse-papiers pour une page à l'essai.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  let service = null;
  let filtre = null;
  /** Une adresse refusée par le mandataire : dite une fois, par sa raison, et non par l'erreur de réseau qu'elle provoque. */
  const refusee = (url) => {
    try {
      const u = new URL(url);
      const port = u.port || (u.protocol === "https:" || u.protocol === "wss:" ? "443" : "80");
      return Boolean(filtre?.refus.includes(`${u.hostname.replace(/^\[|\]$/g, "")}:${port}`));
    } catch {
      return false;
    }
  };
  /*
   * Depuis Electron 35, le niveau et le message sont dans l'événement (le niveau
   * en mot : « error ») ; avant, en arguments (le niveau en nombre, 3 pour une
   * erreur). Les deux sont lus : passage à Electron 44 le 27/09/2026.
   */
  fenetre.webContents.on("console-message", (e, ancienNiveau, ancienMessage) => {
    const niveau = e && e.level !== undefined ? e.level : ancienNiveau;
    const message = String(e && e.message !== undefined ? e.message : ancienMessage);
    if (niveau === "error" || niveau >= 3 || /error|uncaught/i.test(message)) console_.push(message.slice(0, 300));
  });
  ses.webRequest.onErrorOccurred((d) => {
    /*
     * Seulement ce que l'agent peut corriger : un fichier du projet absent, ou
     * une adresse qui répond en erreur. Pas les annulations, ni les échecs de
     * cache d'une session sans cache (mesuré le 26/09/2026 : les polices de
     * Google Fonts sortaient toutes « introuvables », net::ERR_CACHE_MISS).
     */
    if (/ERR_ABORTED|ERR_CACHE_MISS|ERR_BLOCKED_BY_CLIENT/.test(d.error) || refusee(d.url)) return;
    const locale = service && d.url.startsWith(service.origine + "/");
    if (!locale && /fonts\.(googleapis|gstatic)\.com/.test(d.url)) return;
    echecs.push(`${locale ? d.url.slice(service.origine.length + 1) : d.url} (${d.error})`);
  });
  /*
   * Une réponse en erreur n'est pas une erreur de réseau (relecture du
   * 27/09/2026) : un `style.css` absent du projet recevait un 404 du service
   * local, et le rapport n'en disait rien.
   */
  ses.webRequest.onCompleted((d) => {
    if (d.statusCode < 400 || refusee(d.url)) return;
    const locale = service && d.url.startsWith(service.origine + "/");
    echecs.push(`${locale ? d.url.slice(service.origine.length + 1) : d.url} (${d.statusCode === 404 ? "introuvable" : `erreur ${d.statusCode}`})`);
  });
  // Un bouton « Exporter » ne doit pas ouvrir de fenêtre d'enregistrement pendant l'essai.
  ses.on("will-download", (_e, item) => item.cancel());
  // Aucune fenêtre ni navigation hors de la page essayée.
  fenetre.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  fenetre.webContents.on("will-navigate", (e) => e.preventDefault());
  const minuterie = setTimeout(() => fenetre.destroy(), DUREE_MAX_MS);
  try {
    service = await servirDossier(racine);
    /*
     * Internet, mais ni la machine ni le réseau local (seconde tournée du test
     * d'intrusion, 28/09/2026, electron/filtreReseau.cjs) : tout passe par le
     * mandataire, boucle locale comprise (`<-loopback>` retire l'exception que
     * Chromium lui fait d'office), et WebRTC n'ouvre rien à côté de lui.
     */
    filtre = await demarrerFiltre({ permis: `127.0.0.1:${service.serveur.address().port}` });
    await ses.setProxy({ mode: "fixed_servers", proxyRules: `http://127.0.0.1:${filtre.port}`, proxyBypassRules: "<-loopback>" });
    fenetre.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    const relatif = path.relative(service.reelle, fs.realpathSync(fichier));
    if (relatif.startsWith("..") || path.isAbsolute(relatif)) throw new Error("La page n'est pas dans le dossier du projet.");
    const adresse = `${service.origine}/${relatif.split(path.sep).map(encodeURIComponent).join("/")}`;
    await fenetre.loadURL(adresse).catch((err) => echecs.push(String(err?.message ?? err).slice(0, 200)));
    await new Promise((r) => setTimeout(r, ATTENTE_CHARGEMENT_MS));
    const analyse = await fenetre.webContents.executeJavaScript(ANALYSE, true).catch((err) => ({ erreurAnalyse: String(err?.message ?? err) }));
    for (const hote of filtre.refus) echecs.push(`${hote} (adresse de la machine ou du réseau local : refusée pendant l'essai)`);
    return { ok: true, console: [...new Set(console_)].slice(0, 12), ressources: [...new Set(echecs)].slice(0, 12), ...analyse };
  } catch (err) {
    return { ok: false, message: String(err?.message ?? err) };
  } finally {
    clearTimeout(minuterie);
    if (!fenetre.isDestroyed()) fenetre.destroy();
    service?.serveur.close();
    filtre?.fermer();
    void ses.clearStorageData().catch(() => {});
  }
}

/**
 * Démarre le service sur la boucle locale et rend { url, cle } pour la
 * passerelle. Une demande à la fois : un modèle local occupe déjà la machine.
 */
function demarrerRendu() {
  const cle = crypto.randomBytes(24).toString("base64url");
  let occupe = Promise.resolve();
  const serveur = http.createServer((req, res) => {
    const refuser = (code) => { res.writeHead(code); res.end(); };
    if (req.method !== "POST" || req.url !== "/rendre") return refuser(404);
    const recu = String(req.headers["x-oxoai-cle"] ?? "");
    if (recu.length !== cle.length || !crypto.timingSafeEqual(Buffer.from(recu), Buffer.from(cle))) return refuser(403);
    let corps = "";
    req.on("data", (c) => { corps += c; if (corps.length > 10_000) req.destroy(); });
    req.on("end", () => {
      let fichier = "";
      let racine = "";
      try {
        const j = JSON.parse(corps);
        fichier = String(j.fichier ?? "");
        racine = String(j.racine ?? "") || path.dirname(fichier);
      } catch { return refuser(400); }
      // Seulement une page HTML qui existe, par un chemin absolu, dans un dossier qui existe. La passerelle a déjà vérifié le dossier.
      if (!path.isAbsolute(fichier) || !path.isAbsolute(racine) || !/\.html?$/i.test(fichier) || !fs.existsSync(fichier) || !fs.existsSync(racine)) return refuser(400);
      occupe = occupe.then(async () => {
        const rapport = await rendre(fichier, racine);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rapport));
      });
    });
  });
  return new Promise((resolve) => {
    serveur.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${serveur.address().port}`, cle }));
    serveur.on("error", () => resolve(null));
  });
}

module.exports = { demarrerRendu, servirDossier };
