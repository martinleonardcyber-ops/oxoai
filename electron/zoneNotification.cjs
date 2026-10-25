/**
 * Windows et Linux : l'icône dans la zone de notification, et le menu de la
 * fenêtre.
 *
 * Pourquoi (audit Windows et Linux du 27/09/2026) : fermer la fenêtre quittait
 * l'application, donc arrêtait la passerelle, les tâches programmées et les
 * employés, alors que l'écran promet qu'ils continuent « même fenêtre
 * fermée ». Sur macOS, c'est le Dock qui garde l'application ouverte ; ici,
 * c'est cette icône. Fermer la fenêtre la cache, « Quitter » arrête tout.
 *
 * Sur un bureau sans zone de notification (GNOME sans l'extension
 * AppIndicator), l'icône ne se voit pas : relancer l'application rouvre la
 * fenêtre (verrou d'instance unique, `second-instance` dans main.cjs), et le
 * premier avis le dit.
 *
 * Les textes suivent la langue de l'écran, que l'interface donne au démarrage
 * (`oxoai:langue`).
 */

const { Menu, Notification, Tray, nativeImage } = require("electron");

const TEXTES = {
  fr: {
    ouvrir: "Ouvrir {0}",
    quitter: "Quitter {0}",
    bulle: "{0} : les tâches programmées et les employés continuent",
    avisTitre: "{0} reste ouvert",
    avis: "Les tâches programmées et les employés continuent. Rouvrez la fenêtre depuis l'icône de la zone de notification, ou en relançant {0}. « Quitter » arrête tout.",
    fichier: "Fichier",
    edition: "Édition",
    affichage: "Affichage",
    annuler: "Annuler",
    retablir: "Rétablir",
    couper: "Couper",
    copier: "Copier",
    coller: "Coller",
    toutSelectionner: "Tout sélectionner",
    agrandir: "Agrandir le texte",
    reduire: "Réduire le texte",
    tailleNormale: "Taille normale",
    pleinEcran: "Plein écran",
  },
  en: {
    ouvrir: "Open {0}",
    quitter: "Quit {0}",
    bulle: "{0}: scheduled tasks and employees keep running",
    avisTitre: "{0} is still running",
    avis: "Scheduled tasks and employees keep running. Reopen the window from the notification area icon, or by launching {0} again. “Quit” stops everything.",
    fichier: "File",
    edition: "Edit",
    affichage: "View",
    annuler: "Undo",
    retablir: "Redo",
    couper: "Cut",
    copier: "Copy",
    coller: "Paste",
    toutSelectionner: "Select all",
    agrandir: "Zoom in",
    reduire: "Zoom out",
    tailleNormale: "Actual size",
    pleinEcran: "Full screen",
  },
  zh: {
    ouvrir: "打开 {0}",
    quitter: "退出 {0}",
    bulle: "{0}：定时任务和员工继续运行",
    avisTitre: "{0} 仍在运行",
    avis: "定时任务和员工继续运行。可从通知区域图标重新打开窗口，或再次启动 {0}。“退出”会停止一切。",
    fichier: "文件",
    edition: "编辑",
    affichage: "视图",
    annuler: "撤销",
    retablir: "重做",
    couper: "剪切",
    copier: "复制",
    coller: "粘贴",
    toutSelectionner: "全选",
    agrandir: "放大文字",
    reduire: "缩小文字",
    tailleNormale: "实际大小",
    pleinEcran: "全屏",
  },
  // Le japonais depuis le 28/09/2026 (demandé par Medhi).
  ja: {
    ouvrir: "{0} を開く",
    quitter: "{0} を終了",
    bulle: "{0}：スケジュールタスクと従業員は動作を続けます",
    avisTitre: "{0} は動作を続けています",
    avis: "スケジュールタスクと従業員は動作を続けます。ウィンドウは通知領域のアイコンから、または {0} をもう一度起動すると開けます。「終了」を選ぶとすべて停止します。",
    fichier: "ファイル",
    edition: "編集",
    affichage: "表示",
    annuler: "元に戻す",
    retablir: "やり直す",
    couper: "切り取り",
    copier: "コピー",
    coller: "貼り付け",
    toutSelectionner: "すべて選択",
    agrandir: "文字を拡大",
    reduire: "文字を縮小",
    tailleNormale: "実際のサイズ",
    pleinEcran: "フルスクリーン",
  },
  // L'espagnol, l'allemand et l'arabe depuis le 30/09/2026 (demandés par Medhi). Relecture par des personnes dont c'est la langue : à faire.
  es: {
    ouvrir: "Abrir {0}",
    quitter: "Salir de {0}",
    bulle: "{0}: las tareas programadas y los agentes siempre activos siguen funcionando",
    avisTitre: "{0} sigue abierto",
    avis: "Las tareas programadas y los agentes siempre activos siguen funcionando. Vuelve a abrir la ventana desde el icono del área de notificación, o iniciando {0} de nuevo. «Salir» lo detiene todo.",
    fichier: "Archivo",
    edition: "Edición",
    affichage: "Ver",
    annuler: "Deshacer",
    retablir: "Rehacer",
    couper: "Cortar",
    copier: "Copiar",
    coller: "Pegar",
    toutSelectionner: "Seleccionar todo",
    agrandir: "Ampliar el texto",
    reduire: "Reducir el texto",
    tailleNormale: "Tamaño real",
    pleinEcran: "Pantalla completa",
  },
  de: {
    ouvrir: "{0} öffnen",
    quitter: "{0} beenden",
    bulle: "{0}: Geplante Aufgaben und dauerhaft aktive Agenten laufen weiter",
    avisTitre: "{0} läuft weiter",
    avis: "Geplante Aufgaben und dauerhaft aktive Agenten laufen weiter. Öffnen Sie das Fenster wieder über das Symbol im Infobereich oder indem Sie {0} erneut starten. „Beenden“ stoppt alles.",
    fichier: "Datei",
    edition: "Bearbeiten",
    affichage: "Ansicht",
    annuler: "Rückgängig",
    retablir: "Wiederholen",
    couper: "Ausschneiden",
    copier: "Kopieren",
    coller: "Einfügen",
    toutSelectionner: "Alles auswählen",
    agrandir: "Text vergrößern",
    reduire: "Text verkleinern",
    tailleNormale: "Originalgröße",
    pleinEcran: "Vollbild",
  },
  ar: {
    ouvrir: "فتح {0}",
    quitter: "إنهاء {0}",
    bulle: "{0}: المهام المجدولة والوكلاء الدائمو العمل يواصلون عملهم",
    avisTitre: "{0} ما زال يعمل",
    avis: "المهام المجدولة والوكلاء الدائمو العمل يواصلون عملهم. أعد فتح النافذة من أيقونة منطقة الإشعارات، أو بتشغيل {0} من جديد. «إنهاء» يوقف كل شيء.",
    fichier: "ملف",
    edition: "تحرير",
    affichage: "عرض",
    annuler: "تراجع",
    retablir: "إعادة",
    couper: "قص",
    copier: "نسخ",
    coller: "لصق",
    toutSelectionner: "تحديد الكل",
    agrandir: "تكبير النص",
    reduire: "تصغير النص",
    tailleNormale: "الحجم الفعلي",
    pleinEcran: "ملء الشاشة",
  },
};

const remplir = (texte, nom) => texte.replaceAll("{0}", nom);

/**
 * Pose l'icône et le menu. `montrer` rouvre la fenêtre, `quitter` arrête
 * l'application. Rend null si l'icône n'a pas pu être posée : fermer la
 * fenêtre quitte alors, comme avant.
 */
function installerZoneNotification({ nom, icone, langue, montrer, quitter }) {
  let tray;
  let courante = TEXTES[langue] ? langue : "en";
  const txt = (cle) => remplir(TEXTES[courante][cle], nom);
  try {
    // La marque simplifiée (`build/tray.png`, et `tray@2x.png` pour les écrans denses) : l'hélice détaillée ne se lit pas à 16 pixels.
    const image = nativeImage.createFromPath(icone);
    tray = new Tray(image);
  } catch (err) {
    console.error("[oxoai] icône de la zone de notification impossible :", err?.message ?? err);
    return null;
  }

  const construire = () => {
    tray.setToolTip(txt("bulle"));
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: txt("ouvrir"), click: montrer },
        { type: "separator" },
        { label: txt("quitter"), click: quitter },
      ]),
    );
    /*
     * Le menu de la fenêtre : l'essentiel, dans la langue de l'écran. Celui
     * d'Electron par défaut était en anglais, avec les outils de développement
     * et l'aide du site d'Electron. Caché, la touche Alt l'affiche.
     */
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: txt("fichier"), submenu: [{ label: txt("quitter"), accelerator: "Ctrl+Q", click: quitter }] },
        {
          label: txt("edition"),
          submenu: [
            { role: "undo", label: txt("annuler") },
            { role: "redo", label: txt("retablir") },
            { type: "separator" },
            { role: "cut", label: txt("couper") },
            { role: "copy", label: txt("copier") },
            { role: "paste", label: txt("coller") },
            { role: "selectAll", label: txt("toutSelectionner") },
          ],
        },
        {
          label: txt("affichage"),
          submenu: [
            { role: "zoomIn", label: txt("agrandir") },
            { role: "zoomOut", label: txt("reduire") },
            { role: "resetZoom", label: txt("tailleNormale") },
            { type: "separator" },
            { role: "togglefullscreen", label: txt("pleinEcran") },
          ],
        },
      ]),
    );
  };
  construire();
  // Un clic sur l'icône rouvre la fenêtre (Windows) ; sous Linux, c'est le menu qui s'ouvre.
  tray.on("click", montrer);

  let averti = false;
  return {
    changerLangue(l) {
      if (!TEXTES[l] || l === courante) return;
      courante = l;
      construire();
    },
    /** La première fois que la fenêtre se cache, on dit où la retrouver. */
    avertirUneFois() {
      if (averti) return;
      averti = true;
      try {
        if (Notification.isSupported()) new Notification({ title: txt("avisTitre"), body: txt("avis") }).show();
      } catch {
        /* pas de notifications sur ce bureau : l'icône suffit */
      }
    },
  };
}

module.exports = { installerZoneNotification };
