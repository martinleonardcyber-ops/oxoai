/*
 * Le banc d'essai des pages (electron/rendu.cjs) dans un vrai Electron
 * (seconde tournée du test d'intrusion, 28/09/2026) : une page à l'essai
 * peut-elle lire un service de la boucle locale ? Lancé par
 * scripts/securite.mjs avec le binaire d'Electron du projet, jamais
 * l'application installée. Fenêtre cachée, dossier de profil jetable.
 * Rend une ligne JSON.
 *
 * Le service visé répond `Access-Control-Allow-Origin: *`, comme Ollama pour
 * les origines de boucle locale : sans filtre, la page le lisait.
 */
const { app } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const [RACINE] = process.argv.slice(-1);
const profil = fs.mkdtempSync(path.join(os.tmpdir(), "oxoai-banc-profil-"));
app.setPath("userData", profil);
if (app.dock) app.dock.hide();

app.whenReady().then(async () => {
  const fin = (resultat) => {
    console.log(JSON.stringify(resultat));
    fs.rmSync(profil, { recursive: true, force: true });
    app.exit(0);
  };
  setTimeout(() => fin({ plantage: "délai dépassé" }), 60_000).unref();
  try {
    const rendu = require(path.join(RACINE, "electron", "rendu.cjs"));
    const victime = http.createServer((_req, res) => {
      res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" });
      res.end("SECRET-LOCAL");
    });
    await new Promise((r) => victime.listen(0, "127.0.0.1", r));
    const port = victime.address().port;
    const projet = fs.mkdtempSync(path.join(os.tmpdir(), "oxoai-banc-projet-"));
    const essais = ["127.0.0.1", "localhost", "0.0.0.0"].map((h) => `http://${h}:${port}/`);
    fs.writeFileSync(
      path.join(projet, "index.html"),
      `<!doctype html><html><body><p id="r">...</p><script>
      Promise.all(${JSON.stringify(essais)}.map((u) => fetch(u).then((r) => r.text()).then((t) => t === "SECRET-LOCAL" ? "L" : "b", () => "b")))
        .then((l) => { document.getElementById("r").textContent = "R=" + l.join(""); });
      </script></body></html>`,
    );
    const service = await rendu.demarrerRendu();
    const rapport = await fetch(`${service.url}/rendre`, {
      method: "POST",
      headers: { "x-oxoai-cle": service.cle, "content-type": "application/json" },
      body: JSON.stringify({ fichier: path.join(projet, "index.html"), racine: projet }),
    }).then((r) => r.json());
    fs.rmSync(projet, { recursive: true, force: true });
    victime.close();
    fin({ extrait: rapport.extrait ?? null, ressources: rapport.ressources ?? [], ok: rapport.ok });
  } catch (err) {
    fin({ plantage: String(err && err.stack).slice(0, 300) });
  }
});
