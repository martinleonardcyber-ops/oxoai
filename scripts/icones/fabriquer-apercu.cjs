/**
 * Fabrique docs/images/apercu-github.png, l'image d'aperçu du dépôt (1280 × 640, format
 * conseillé par GitHub ; posée dans Settings › Social preview, qui n'a pas d'API).
 * 27/09/2026, demandé par Medhi. Lancer : npx electron scripts/icones/fabriquer-apercu.cjs
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const R = path.join(__dirname, "..", "..");
const b64 = (p) => fs.readFileSync(path.join(R, p)).toString("base64");
const page = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Plus Jakarta Sans"; src: url(data:font/woff2;base64,${b64("public/fonts/plus-jakarta-sans-latin.woff2")}) format("woff2"); font-weight: 200 800; }
* { margin: 0; box-sizing: border-box; }
html, body { width: 1280px; height: 640px; overflow: hidden; background: #FAFAF7; font-family: "Plus Jakarta Sans", -apple-system, sans-serif; color: #16140F; }
.fond { position: absolute; inset: 0; background: radial-gradient(900px 520px at 88% 30%, #EFEDE6 0%, rgba(239,237,230,0) 70%); }
.gauche { position: absolute; left: 72px; top: 0; bottom: 0; width: 560px; display: flex; flex-direction: column; justify-content: center; }
.logo { width: 330px; margin-left: -59px; margin-bottom: 26px; }
h1 { font-size: 46px; line-height: 1.08; font-weight: 700; letter-spacing: -0.02em; }
.sous { margin-top: 18px; font-size: 21px; line-height: 1.45; color: #57534A; font-weight: 500; }
.puces { margin-top: 30px; display: flex; flex-wrap: wrap; gap: 10px; }
.puce { font-size: 15px; font-weight: 600; padding: 8px 14px; border-radius: 999px; border: 1px solid #DDD9D0; background: #FFFFFF; color: #2A2721; }
.puce.forte { background: #16140F; color: #FAFAF7; border-color: #16140F; }
.capture { position: absolute; left: 680px; top: 92px; width: 720px; border-radius: 16px; overflow: hidden; box-shadow: 0 30px 70px rgba(22,20,15,0.18), 0 0 0 1px rgba(22,20,15,0.08); background: #fff; }
.capture img { display: block; width: 100%; }
</style></head><body><div class="fond"></div>
<div class="gauche">
  <img class="logo" src="data:image/png;base64,${b64("src/assets/oxoai-logo.png")}">
  <h1>Your own AI workspace,<br>on your own machines.</h1>
  <p class="sous">Chat, agents, coding, knowledge bases and fine-tuning with local models. Your data stays with you.</p>
  <div class="puces"><span class="puce forte">Open source · AGPL-3.0</span><span class="puce">macOS · Windows · Linux</span><span class="puce">Local models</span></div>
</div>
<script>
(function () {
  var img = document.querySelector(".logo"), source = new Image();
  source.onload = function () {
    var c = document.createElement("canvas"); c.width = source.width; c.height = source.height;
    var g = c.getContext("2d"); g.drawImage(source, 0, 0);
    var d = g.getImageData(0, 0, c.width, c.height), px = d.data;
    for (var i = 0; i < px.length; i += 4) {
      var a = 255 - Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
      px[i] = 0x16; px[i + 1] = 0x14; px[i + 2] = 0x0F; px[i + 3] = a < 24 ? 0 : a;
    }
    g.putImageData(d, 0, 0); img.src = c.toDataURL("image/png"); window.logoPret = true;
  };
  source.src = img.src;
})();
</script>
<div class="capture"><img src="data:image/png;base64,${b64("docs/images/chat.png")}"></div>
</body></html>`;
app.whenReady().then(async () => {
  const f = new BrowserWindow({ width: 1280, height: 640, show: false, useContentSize: true, webPreferences: { offscreen: true } });
  f.webContents.setZoomFactor(1);
  await f.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(page));
  for (let i = 0; i < 50 && !(await f.webContents.executeJavaScript("window.logoPret === true")); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 400));
  const img = await f.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 640 });
  const png = img.resize({ width: 1280, height: 640, quality: "best" }).toPNG();
  fs.writeFileSync(path.join(R, "docs", "images", "apercu-github.png"), png);
  console.log("image écrite", img.getSize());
  app.quit();
});
