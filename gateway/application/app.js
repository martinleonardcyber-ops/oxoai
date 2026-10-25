/*
 * Moteur de l'application, écrit par OxoAI (gateway/application/app.js).
 *
 * Tout ce qui est propre au métier est ailleurs :
 *  - app/plan.js : les parties de l'application, leurs champs et les exemples ;
 *  - app/metier.js : les règles (calculs, contrôles, indicateurs).
 * Ce fichier affiche le plan tel qu'il est : ajouter un champ ou une partie
 * dans plan.js suffit, sans toucher au moteur.
 */
(function () {
  "use strict";

  var PLAN = window.PLAN;
  var METIER = window.Metier || {};
  var PAR_PAGE = 12;
  var CLE_STOCKAGE = "oxoai-app:" + (PLAN.cle || PLAN.nom);

  /* ---------------- Icônes ---------------- */
  var ICONES = {
    accueil: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    dossier: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    personne: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    groupe: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M22 20a7 7 0 0 0-4-6.3"/>',
    facture: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    argent: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>',
    calendrier: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    horloge: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    document: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>',
    tache: '<path d="M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11"/>',
    boite: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
    camion: '<path d="M2 6h11v10H2zM13 10h5l3 3v3h-8"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
    graphique: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    batiment: '<path d="M4 21V5l8-3 8 3v16"/><path d="M9 21v-5h6v5M8 8h2M14 8h2M8 12h2M14 12h2"/>',
    balance: '<path d="M12 3v18M5 21h14M6 7h12"/><path d="M6 7l-3 7a3 3 0 0 0 6 0zM18 7l-3 7a3 3 0 0 0 6 0z"/>',
    outil: '<path d="M14 6a4 4 0 0 0 5 5l-9 9-3-3 9-9a4 4 0 0 1-2-2z"/>',
    message: '<path d="M4 5h16v11H8l-4 4z"/>',
    etoile: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    recherche: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    crayon: '<path d="M4 20h4L20 8l-4-4L4 16z"/>',
    corbeille: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    exporter: '<path d="M12 4v11M7 10l5 5 5-5M4 20h16"/>',
    fermer: '<path d="M6 6l12 12M18 6L6 18"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    fleche: '<path d="M9 6l6 6-6 6"/>',
  };
  function icone(nom) {
    return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONES[nom] || ICONES.dossier) + "</svg>";
  }

  /* ---------------- Outils ---------------- */
  function echapper(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function nouvelId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function euros(n) {
    var x = Number(n);
    return isFinite(x) ? x.toLocaleString("fr-FR", { style: "currency", currency: "EUR" }) : "";
  }
  function dateFr(v) {
    if (!v) return "";
    var d = new Date(v + (String(v).length === 10 ? "T00:00:00" : ""));
    // Une date illisible est rendue telle quelle, mais échappée : elle part dans innerHTML (28/09/2026).
    return isNaN(d.getTime()) ? echapper(v) : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
  }
  /** « Montant HT » devient « montant HT » : seule la première lettre, et seulement si le mot suivant n'est pas un sigle. */
  function minuscule(t) {
    t = String(t || "");
    return /^[A-ZÀ-Ý][a-zà-ÿ]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
  }
  function moduleDe(cle) {
    for (var i = 0; i < PLAN.modules.length; i++) if (PLAN.modules[i].cle === cle) return PLAN.modules[i];
    return null;
  }
  function champDe(m, cle) {
    for (var i = 0; i < m.champs.length; i++) if (m.champs[i].cle === cle) return m.champs[i];
    return null;
  }
  function titreDe(m, fiche) {
    if (!fiche) return "";
    var v = fiche[m.titre];
    return v == null || v === "" ? m.unite + " sans nom" : String(v);
  }
  function ficheDe(cleModule, id) {
    var liste = donnees[cleModule] || [];
    for (var i = 0; i < liste.length; i++) if (liste[i].id === id) return liste[i];
    return null;
  }
  /** Les parties dont un champ renvoie vers `m` (ex. les dossiers d'un client). */
  function liesA(m) {
    var r = [];
    PLAN.modules.forEach(function (autre) {
      autre.champs.forEach(function (c) {
        if (c.type === "lien" && c.lien === m.cle) r.push({ module: autre, champ: c });
      });
    });
    return r;
  }
  function premierChamp(m, type) {
    for (var i = 0; i < m.champs.length; i++) if (m.champs[i].type === type) return m.champs[i];
    return null;
  }

  /* ---------------- Champs ajoutés par les règles du métier ---------------- */
  var TYPES = ["texte", "long", "nombre", "montant", "date", "choix", "lien", "courriel", "telephone", "oui_non"];
  (function ajouterChamps() {
    var ajouts = METIER.champs || {};
    Object.keys(ajouts).forEach(function (cle) {
      var m = moduleDe(cle);
      if (!m || !Array.isArray(ajouts[cle])) return;
      ajouts[cle].forEach(function (c) {
        if (!c || !c.cle || champDe(m, c.cle)) return;
        var type = TYPES.indexOf(c.type) >= 0 ? c.type : "texte";
        if (type === "choix" && !(Array.isArray(c.options) && c.options.length)) type = "texte";
        if (type === "lien" && !moduleDe(c.lien)) type = "texte";
        m.champs.push({ cle: String(c.cle), libelle: String(c.libelle || c.cle), type: type, options: c.options, lien: c.lien, obligatoire: !!c.obligatoire && !c.calcule, calcule: !!c.calcule });
      });
    });
  })();

  /* ---------------- Données ---------------- */
  var donnees = charger();
  function charger() {
    try {
      var brut = localStorage.getItem(CLE_STOCKAGE);
      if (brut) {
        var lu = JSON.parse(brut);
        if (lu && typeof lu === "object") {
          PLAN.modules.forEach(function (m) { if (!Array.isArray(lu[m.cle])) lu[m.cle] = []; });
          return lu;
        }
      }
    } catch (e) { /* stockage indisponible : on part des exemples */ }
    return exemples();
  }
  function exemples() {
    var d = {};
    PLAN.modules.forEach(function (m) {
      d[m.cle] = (PLAN.exemples && PLAN.exemples[m.cle] ? PLAN.exemples[m.cle] : []).map(function (f) {
        var copie = {};
        for (var k in f) copie[k] = f[k];
        return copie;
      });
    });
    return d;
  }
  /** Les champs calculés de toutes les fiches, repassés par les règles du métier (les exemples n'ont que les champs saisis). */
  function recalculer() {
    if (!METIER.completer) return;
    PLAN.modules.forEach(function (m) {
      if (!m.champs.some(function (c) { return c.calcule; })) return;
      (donnees[m.cle] || []).forEach(function (f) {
        try { METIER.completer(m.cle, f, donnees); } catch (e) { console.error(e); }
      });
    });
  }
  function enregistrerTout() {
    recalculer();
    try {
      localStorage.setItem(CLE_STOCKAGE, JSON.stringify(donnees));
      return true;
    } catch (e) {
      annoncer("Enregistrement impossible sur ce poste : les modifications seront perdues à la fermeture.", true);
      return false;
    }
  }

  /* ---------------- État de l'écran ---------------- */
  var etat = {
    vue: "accueil",
    recherche: "",
    filtres: {},
    tri: null,
    sens: 1,
    page: 0,
    choisie: null,
    menuOuvert: false,
  };

  /* ---------------- Affichage des valeurs ---------------- */
  function pastille(champ, v) {
    if (v == null || v === "") return "";
    var i = (champ.options || []).indexOf(v);
    return '<span class="pastille pastille--' + (i < 0 ? 0 : i % 6) + '">' + echapper(v) + "</span>";
  }
  function valeur(champ, v) {
    if (v == null || v === "") return '<span class="vide">—</span>';
    switch (champ.type) {
      case "montant": return euros(v);
      case "nombre": return Number(v).toLocaleString("fr-FR");
      case "date": return dateFr(v);
      case "choix": return pastille(champ, v);
      case "oui_non": return v === true || v === "oui" ? "Oui" : "Non";
      case "courriel": return '<a href="mailto:' + echapper(v) + '">' + echapper(v) + "</a>";
      case "lien": {
        var cible = moduleDe(champ.lien);
        var f = cible ? ficheDe(cible.cle, v) : null;
        return f ? '<button type="button" class="lien" data-action="aller" data-module="' + echapper(cible.cle) + '" data-id="' + echapper(f.id) + '">' + echapper(titreDe(cible, f)) + "</button>" : '<span class="vide">—</span>';
      }
      default: return echapper(v);
    }
  }
  function texteBrut(champ, v) {
    if (v == null) return "";
    if (champ.type === "lien") {
      var cible = moduleDe(champ.lien);
      return cible ? titreDe(cible, ficheDe(cible.cle, v)) : "";
    }
    return String(v);
  }

  /* ---------------- Liste filtrée ---------------- */
  function listeVisible(m) {
    var liste = (donnees[m.cle] || []).slice();
    var q = etat.recherche.trim().toLowerCase();
    if (q) {
      liste = liste.filter(function (f) {
        return m.champs.some(function (c) { return texteBrut(c, f[c.cle]).toLowerCase().indexOf(q) >= 0; });
      });
    }
    Object.keys(etat.filtres).forEach(function (cle) {
      var voulu = etat.filtres[cle];
      if (voulu === "" || voulu == null) return;
      if (cle === "__du" || cle === "__au") {
        var cd = premierChamp(m, "date");
        if (!cd) return;
        liste = liste.filter(function (f) {
          var v = f[cd.cle] || "";
          return cle === "__du" ? v >= voulu : v <= voulu;
        });
        return;
      }
      liste = liste.filter(function (f) { return String(f[cle]) === String(voulu); });
    });
    if (etat.tri) {
      var c = champDe(m, etat.tri);
      liste.sort(function (a, b) {
        var x = a[etat.tri], y = b[etat.tri];
        if (c && (c.type === "montant" || c.type === "nombre")) return ((Number(x) || 0) - (Number(y) || 0)) * etat.sens;
        return texteBrut(c || {}, x).localeCompare(texteBrut(c || {}, y), "fr") * etat.sens;
      });
    }
    return liste;
  }

  /* ---------------- Rendu ---------------- */
  var racine = document.getElementById("app");

  function rafraichir() {
    rendreMenu();
    if (etat.vue === "accueil") rendreAccueil();
    else rendreModule(moduleDe(etat.vue));
  }

  function rendreMenu() {
    var nav = document.getElementById("menu");
    var html = '<button type="button" class="menu__entree' + (etat.vue === "accueil" ? " est-active" : "") + '" data-action="vue" data-vue="accueil">' + icone("accueil") + "<span>Tableau de bord</span></button>";
    PLAN.modules.forEach(function (m) {
      html += '<button type="button" class="menu__entree' + (etat.vue === m.cle ? " est-active" : "") + '" data-action="vue" data-vue="' + echapper(m.cle) + '">' + icone(m.icone) + "<span>" + echapper(m.nom) + '</span><span class="menu__compte">' + (donnees[m.cle] || []).length + "</span></button>";
    });
    nav.innerHTML = html;
    document.getElementById("filtres").innerHTML = etat.vue === "accueil" ? "" : rendreFiltres(moduleDe(etat.vue));
    document.body.classList.toggle("menu-ouvert", etat.menuOuvert);
  }

  function rendreFiltres(m) {
    var html = '<p class="filtres__titre">Filtres</p>';
    var aDesFiltres = false;
    m.champs.forEach(function (c) {
      if (c.type !== "choix" && c.type !== "lien") return;
      aDesFiltres = true;
      var options = c.type === "choix"
        ? (c.options || []).map(function (o) { return { v: o, t: o }; })
        : (donnees[c.lien] || []).map(function (f) { return { v: f.id, t: titreDe(moduleDe(c.lien), f) }; });
      html += '<label class="filtre"><span>' + echapper(c.libelle) + '</span><select data-action="filtre" data-champ="' + echapper(c.cle) + '"><option value="">Tous</option>';
      options.forEach(function (o) {
        html += '<option value="' + echapper(o.v) + '"' + (String(etat.filtres[c.cle]) === String(o.v) ? " selected" : "") + ">" + echapper(o.t) + "</option>";
      });
      html += "</select></label>";
    });
    var cd = premierChamp(m, "date");
    if (cd) {
      aDesFiltres = true;
      html += '<label class="filtre"><span>' + echapper(cd.libelle) + ' : du</span><input type="date" data-action="filtre" data-champ="__du" value="' + echapper(etat.filtres.__du || "") + '"></label>';
      html += '<label class="filtre"><span>au</span><input type="date" data-action="filtre" data-champ="__au" value="' + echapper(etat.filtres.__au || "") + '"></label>';
    }
    if (!aDesFiltres) return "";
    return html + '<button type="button" class="bouton bouton--discret bouton--plein" data-action="effacer-filtres">Effacer les filtres</button>';
  }

  function tuile(libelle, val, detail, cle) {
    return '<button type="button" class="tuile" ' + (cle ? 'data-action="vue" data-vue="' + echapper(cle) + '"' : "disabled") + '><span class="tuile__libelle">' + echapper(libelle) + '</span><span class="tuile__valeur">' + val + "</span>" + (detail ? '<span class="tuile__detail">' + detail + "</span>" : "") + "</button>";
  }

  function rendreAccueil() {
    var tuiles = "";
    PLAN.modules.forEach(function (m) {
      var liste = donnees[m.cle] || [];
      var cm = premierChamp(m, "montant");
      var detail = cm ? "Total " + echapper(minuscule(cm.libelle)) + " : " + euros(liste.reduce(function (s, f) { return s + (Number(f[cm.cle]) || 0); }, 0)) : "";
      tuiles += tuile(m.nom, liste.length.toLocaleString("fr-FR"), detail, m.cle);
    });
    var extra = [];
    try { extra = METIER.indicateurs ? METIER.indicateurs(donnees) || [] : []; } catch (e) { console.error(e); }
    extra.forEach(function (x) { tuiles += tuile(x.libelle, echapper(x.valeur), x.detail ? echapper(x.detail) : "", null); });

    var repartitions = "";
    PLAN.modules.forEach(function (m) {
      var cs = m.statut ? champDe(m, m.statut) : null;
      if (!cs) return;
      var liste = donnees[m.cle] || [];
      var lignes = (cs.options || []).map(function (o, i) {
        var n = liste.filter(function (f) { return f[cs.cle] === o; }).length;
        var pct = liste.length ? Math.round((n / liste.length) * 100) : 0;
        return '<div class="barre"><span class="barre__nom">' + pastille(cs, o) + '</span><span class="barre__piste"><span class="barre__jauge barre__jauge--' + (i % 6) + '" style="width:' + pct + '%"></span></span><span class="barre__n">' + n + "</span></div>";
      }).join("");
      repartitions += '<section class="panneau"><header class="panneau__entete"><h2>' + echapper(m.nom) + " par " + echapper(minuscule(cs.libelle)) + "</h2></header><div class=\"panneau__corps\">" + lignes + "</div></section>";
    });

    var recents = "";
    var m0 = PLAN.modules[0];
    var derniers = (donnees[m0.cle] || []).slice(-6).reverse();
    var colonnes = colonnesDe(m0).slice(0, 4);
    recents = '<section class="panneau panneau--large"><header class="panneau__entete"><h2>Derniers ' + echapper(m0.nom.toLowerCase()) + '</h2><button type="button" class="bouton bouton--discret" data-action="vue" data-vue="' + echapper(m0.cle) + '">Tout voir</button></header>' +
      (derniers.length
        ? '<div class="defile"><table class="tableau"><thead><tr>' + colonnes.map(function (c) { return "<th>" + echapper(c.libelle) + "</th>"; }).join("") + "</tr></thead><tbody>" +
          derniers.map(function (f) { return '<tr data-action="aller" data-module="' + echapper(m0.cle) + '" data-id="' + echapper(f.id) + '">' + colonnes.map(function (c) { return '<td class="' + classeCellule(c) + '">' + valeur(c, f[c.cle]) + "</td>"; }).join("") + "</tr>"; }).join("") +
          "</tbody></table></div>"
        : '<p class="vide-bloc">Aucun élément pour l\'instant.</p>') + "</section>";

    racine.innerHTML =
      '<div class="page-entete"><div><h1>Tableau de bord</h1><p class="attenue">' + echapper(PLAN.sousTitre || "") + "</p></div>" +
      '<div class="rangee">' + PLAN.modules.slice(0, 3).map(function (m) { return '<button type="button" class="bouton bouton--secondaire" data-action="nouveau" data-module="' + echapper(m.cle) + '">' + icone("plus") + echapper(m.unite) + "</button>"; }).join("") + "</div></div>" +
      '<div class="tuiles">' + tuiles + "</div>" +
      '<div class="grille-accueil">' + recents + repartitions + "</div>";
  }

  function colonnesDe(m) {
    var cols = m.champs.filter(function (c) { return c.liste !== false && c.type !== "long"; });
    return cols.slice(0, 7);
  }
  function classeCellule(c) {
    if (c.type === "montant" || c.type === "nombre") return "nombre";
    return c.type === "date" || c.type === "choix" || c.type === "telephone" ? "serre" : "";
  }

  function rendreModule(m) {
    if (!m) { etat.vue = "accueil"; return rendreAccueil(); }
    var liste = listeVisible(m);
    var pages = Math.max(1, Math.ceil(liste.length / PAR_PAGE));
    if (etat.page >= pages) etat.page = pages - 1;
    var morceau = liste.slice(etat.page * PAR_PAGE, (etat.page + 1) * PAR_PAGE);
    if (etat.choisie && !ficheDe(m.cle, etat.choisie)) etat.choisie = null;
    if (!etat.choisie && morceau.length) etat.choisie = morceau[0].id;
    var cols = colonnesDe(m);
    var cm = premierChamp(m, "montant");

    var tete = "<tr>" + cols.map(function (c) {
      var fleche = etat.tri === c.cle ? (etat.sens > 0 ? " ▲" : " ▼") : "";
      return '<th class="' + classeCellule(c) + '"><button type="button" class="tri" data-action="trier" data-champ="' + echapper(c.cle) + '">' + echapper(c.libelle) + fleche + "</button></th>";
    }).join("") + "</tr>";
    var corps = morceau.length
      ? morceau.map(function (f) {
          return '<tr class="' + (f.id === etat.choisie ? "est-choisie" : "") + '" data-action="choisir" data-id="' + echapper(f.id) + '">' + cols.map(function (c) { return '<td class="' + classeCellule(c) + '">' + valeur(c, f[c.cle]) + "</td>"; }).join("") + "</tr>";
        }).join("")
      : '<tr><td class="vide-bloc" colspan="' + cols.length + '">' + ((donnees[m.cle] || []).length ? "Aucun résultat pour ces filtres." : "Aucun élément pour l'instant : ajoutez le premier.") + "</td></tr>";

    var total = cm ? '<span class="attenue">Total ' + echapper(minuscule(cm.libelle)) + " : <strong>" + euros(liste.reduce(function (s, f) { return s + (Number(f[cm.cle]) || 0); }, 0)) + "</strong></span>" : "";

    racine.innerHTML =
      '<div class="page-entete"><div><h1>' + echapper(m.nom) + '</h1><p class="attenue">' + liste.length + " sur " + (donnees[m.cle] || []).length + "</p></div>" +
      '<div class="rangee"><label class="recherche">' + icone("recherche") + '<input type="search" placeholder="Rechercher" aria-label="Rechercher dans ' + echapper(m.nom.toLowerCase()) + '" data-action="rechercher" value="' + echapper(etat.recherche) + '"></label>' +
      '<button type="button" class="bouton bouton--secondaire" data-action="exporter">' + icone("exporter") + "Exporter</button>" +
      '<button type="button" class="bouton" data-action="nouveau" data-module="' + echapper(m.cle) + '">' + icone("plus") + "Nouveau</button></div></div>" +
      '<div class="espace-travail">' +
      '<section class="panneau panneau--liste"><div class="defile"><table class="tableau tableau--choix"><thead>' + tete + "</thead><tbody>" + corps + "</tbody></table></div>" +
      '<footer class="pagination">' + total + '<span class="pagination__pas"><button type="button" class="bouton bouton--icone" data-action="page" data-pas="-1" aria-label="Page précédente"' + (etat.page === 0 ? " disabled" : "") + '><span class="retourne">' + icone("fleche") + "</span></button><span>Page " + (etat.page + 1) + " / " + pages + '</span><button type="button" class="bouton bouton--icone" data-action="page" data-pas="1" aria-label="Page suivante"' + (etat.page >= pages - 1 ? " disabled" : "") + ">" + icone("fleche") + "</button></span></footer></section>" +
      rendreDetail(m) + "</div>";
  }

  function rendreDetail(m) {
    var f = etat.choisie ? ficheDe(m.cle, etat.choisie) : null;
    if (!f) return '<aside class="panneau panneau--detail"><p class="vide-bloc">Choisissez une ligne pour voir le détail.</p></aside>';
    var champs = m.champs.map(function (c) {
      return '<div class="detail__champ' + (c.type === "long" ? " detail__champ--large" : "") + '"><dt>' + echapper(c.libelle) + "</dt><dd>" + valeur(c, f[c.cle]) + "</dd></div>";
    }).join("");
    var lies = liesA(m).map(function (l) {
      var liste = (donnees[l.module.cle] || []).filter(function (x) { return x[l.champ.cle] === f.id; });
      var cols = colonnesDe(l.module).filter(function (c) { return c.cle !== l.champ.cle; }).slice(0, 3);
      return '<section class="detail__lies"><header><h3>' + echapper(l.module.nom) + ' <span class="attenue">(' + liste.length + ')</span></h3><button type="button" class="bouton bouton--discret" data-action="nouveau" data-module="' + echapper(l.module.cle) + '" data-lien="' + echapper(l.champ.cle) + '" data-id="' + echapper(f.id) + '">' + icone("plus") + "Ajouter</button></header>" +
        (liste.length
          ? '<div class="defile"><table class="tableau tableau--petit"><thead><tr>' + cols.map(function (c) { return '<th class="' + classeCellule(c) + '">' + echapper(c.libelle) + "</th>"; }).join("") + "</tr></thead><tbody>" +
            liste.map(function (x) { return '<tr data-action="aller" data-module="' + echapper(l.module.cle) + '" data-id="' + echapper(x.id) + '">' + cols.map(function (c) { return '<td class="' + classeCellule(c) + '">' + valeur(c, x[c.cle]) + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table></div>"
          : '<p class="attenue petit">Aucun pour l\'instant.</p>') + "</section>";
    }).join("");
    return '<aside class="panneau panneau--detail"><header class="panneau__entete"><h2>' + echapper(titreDe(m, f)) + '</h2><span class="rangee">' +
      '<button type="button" class="bouton bouton--icone" data-action="modifier" data-id="' + echapper(f.id) + '" aria-label="Modifier">' + icone("crayon") + "</button>" +
      '<button type="button" class="bouton bouton--icone bouton--danger" data-action="supprimer" data-id="' + echapper(f.id) + '" aria-label="Supprimer">' + icone("corbeille") + "</button></span></header>" +
      '<dl class="detail">' + champs + "</dl>" + lies + "</aside>";
  }

  /* ---------------- Formulaire ---------------- */
  var fenetre = document.getElementById("fenetre");
  var formulaire = document.getElementById("formulaire");
  var edition = null;

  function champSaisie(c, v) {
    var id = "champ-" + c.cle;
    var requis = c.obligatoire ? " required" : "";
    var entree;
    if (c.type === "long") entree = '<textarea id="' + echapper(id) + '" name="' + echapper(c.cle) + '" rows="3"' + requis + ">" + echapper(v) + "</textarea>";
    else if (c.type === "choix") {
      entree = '<select id="' + echapper(id) + '" name="' + echapper(c.cle) + '"' + requis + ">" + (c.options || []).map(function (o, i) {
        return '<option value="' + echapper(o) + '"' + ((v == null ? i === 0 : v === o) ? " selected" : "") + ">" + echapper(o) + "</option>";
      }).join("") + "</select>";
    } else if (c.type === "lien") {
      var cible = moduleDe(c.lien);
      var liste = cible ? donnees[cible.cle] || [] : [];
      var choisi = v == null && c.obligatoire && liste.length ? liste[0].id : v;
      entree = '<select id="' + echapper(id) + '" name="' + echapper(c.cle) + '"' + requis + ">" + (c.obligatoire ? "" : '<option value="">Aucun</option>') + liste.map(function (f) {
        return '<option value="' + echapper(f.id) + '"' + (choisi === f.id ? " selected" : "") + ">" + echapper(titreDe(cible, f)) + "</option>";
      }).join("") + "</select>";
    } else if (c.type === "oui_non") {
      entree = '<select id="' + echapper(id) + '" name="' + echapper(c.cle) + '"><option value="non">Non</option><option value="oui"' + (v === true || v === "oui" ? " selected" : "") + ">Oui</option></select>";
    } else {
      if (v == null && c.type === "date") v = new Date().toISOString().slice(0, 10);
      var type = { montant: "number", nombre: "number", date: "date", courriel: "email", telephone: "tel" }[c.type] || "text";
      var pas = c.type === "montant" ? ' step="0.01" min="0"' : c.type === "nombre" ? ' step="any"' : "";
      entree = '<input id="' + echapper(id) + '" name="' + echapper(c.cle) + '" type="' + type + '"' + pas + requis + ' value="' + echapper(v == null ? "" : v) + '">';
    }
    return '<div class="champ' + (c.type === "long" ? " champ--large" : "") + '"><label for="' + echapper(id) + '">' + echapper(c.libelle) + (c.obligatoire ? ' <span class="requis" aria-hidden="true">*</span>' : "") + "</label>" + entree + "</div>";
  }

  function ouvrirFormulaire(m, fiche, prerempli) {
    edition = { module: m, id: fiche ? fiche.id : null };
    var base = fiche || prerempli || {};
    document.getElementById("fenetre-titre").textContent = (fiche ? "Modifier : " + titreDe(m, fiche) : "Nouveau : " + m.unite.toLowerCase());
    document.getElementById("formulaire-champs").innerHTML = m.champs.filter(function (c) { return !c.calcule; }).map(function (c) { return champSaisie(c, base[c.cle]); }).join("");
    document.getElementById("formulaire-erreur").textContent = "";
    fenetre.hidden = false;
    var premier = formulaire.querySelector("input, select, textarea");
    if (premier) premier.focus();
  }
  function fermerFenetre() {
    fenetre.hidden = true;
    edition = null;
  }

  function lireFormulaire(m) {
    var fiche = {};
    var ancienne = edition && edition.id ? ficheDe(m.cle, edition.id) : null;
    m.champs.forEach(function (c) {
      var el = formulaire.elements[c.cle];
      if (!el) {
        if (ancienne && c.calcule) fiche[c.cle] = ancienne[c.cle];
        return;
      }
      var v = el.value;
      if (c.type === "montant" || c.type === "nombre") fiche[c.cle] = v === "" ? null : Number(v);
      else if (c.type === "oui_non") fiche[c.cle] = v === "oui";
      else fiche[c.cle] = v.trim ? v.trim() : v;
    });
    return fiche;
  }

  formulaire.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!edition) return;
    var m = edition.module;
    var fiche = lireFormulaire(m);
    var ancienne = edition.id ? ficheDe(m.cle, edition.id) : null;
    fiche.id = ancienne ? ancienne.id : nouvelId();
    try { if (METIER.completer) METIER.completer(m.cle, fiche, donnees); } catch (err) { console.error(err); }
    var probleme = "";
    try { probleme = METIER.valider ? METIER.valider(m.cle, fiche, donnees) || "" : ""; } catch (err) { console.error(err); }
    if (probleme) {
      document.getElementById("formulaire-erreur").textContent = probleme;
      return;
    }
    if (ancienne) {
      var liste = donnees[m.cle];
      liste[liste.indexOf(ancienne)] = fiche;
    } else donnees[m.cle].push(fiche);
    enregistrerTout();
    fermerFenetre();
    etat.vue = m.cle;
    etat.choisie = fiche.id;
    rafraichir();
    annoncer((ancienne ? "Modifications enregistrées : " : "Enregistré : ") + titreDe(m, fiche) + ".");
  });

  /* ---------------- Confirmation ---------------- */
  var aConfirmer = null;
  function demanderConfirmation(texte, action) {
    aConfirmer = action;
    document.getElementById("confirmation-texte").textContent = texte;
    document.getElementById("confirmation").hidden = false;
  }

  function supprimer(m, id) {
    var f = ficheDe(m.cle, id);
    if (!f) return;
    var dependants = liesA(m).reduce(function (n, l) {
      return n + (donnees[l.module.cle] || []).filter(function (x) { return x[l.champ.cle] === id; }).length;
    }, 0);
    demanderConfirmation(
      "Supprimer « " + titreDe(m, f) + " » ?" + (dependants ? " " + dependants + " élément(s) lié(s) garderont un lien vide." : "") + " Cette action est définitive.",
      function () {
        donnees[m.cle] = donnees[m.cle].filter(function (x) { return x.id !== id; });
        liesA(m).forEach(function (l) {
          (donnees[l.module.cle] || []).forEach(function (x) { if (x[l.champ.cle] === id) x[l.champ.cle] = ""; });
        });
        etat.choisie = null;
        enregistrerTout();
        rafraichir();
        annoncer("Supprimé : " + titreDe(m, f) + ".");
      },
    );
  }

  /* ---------------- Export ---------------- */
  function exporter(m) {
    var liste = listeVisible(m);
    var sep = ";";
    var cellule = function (t) { return '"' + String(t == null ? "" : t).replace(/"/g, '""') + '"'; };
    var lignes = [m.champs.map(function (c) { return cellule(c.libelle); }).join(sep)];
    liste.forEach(function (f) { lignes.push(m.champs.map(function (c) { return cellule(texteBrut(c, f[c.cle])); }).join(sep)); });
    var blob = new Blob(["﻿" + lignes.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = m.cle + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    annoncer(liste.length + " ligne(s) exportée(s).");
  }

  /* ---------------- Annonces ---------------- */
  var minuterie = null;
  function annoncer(texte, grave) {
    var z = document.getElementById("annonce");
    z.textContent = texte;
    z.className = "annonce est-visible" + (grave ? " annonce--grave" : "");
    clearTimeout(minuterie);
    minuterie = setTimeout(function () { z.className = "annonce"; }, 3500);
  }

  /* ---------------- Actions ---------------- */
  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-action]");
    if (!el || el.tagName === "SELECT" || el.tagName === "INPUT") return;
    var action = el.getAttribute("data-action");
    var m = moduleDe(etat.vue);
    switch (action) {
      case "vue":
        etat.vue = el.getAttribute("data-vue");
        etat.recherche = ""; etat.filtres = {}; etat.tri = null; etat.page = 0; etat.choisie = null; etat.menuOuvert = false;
        rafraichir();
        break;
      case "aller":
        etat.vue = el.getAttribute("data-module");
        etat.recherche = ""; etat.filtres = {}; etat.page = 0;
        etat.choisie = el.getAttribute("data-id");
        var cible = moduleDe(etat.vue);
        var pos = listeVisible(cible).findIndex(function (f) { return f.id === etat.choisie; });
        etat.page = pos > 0 ? Math.floor(pos / PAR_PAGE) : 0;
        rafraichir();
        break;
      case "choisir":
        etat.choisie = el.getAttribute("data-id");
        rafraichir();
        break;
      case "trier": {
        var c = el.getAttribute("data-champ");
        etat.sens = etat.tri === c ? -etat.sens : 1;
        etat.tri = c;
        rafraichir();
        break;
      }
      case "page":
        etat.page = Math.max(0, etat.page + Number(el.getAttribute("data-pas")));
        rafraichir();
        break;
      case "nouveau": {
        var mm = moduleDe(el.getAttribute("data-module"));
        var pre = {};
        if (el.getAttribute("data-lien")) pre[el.getAttribute("data-lien")] = el.getAttribute("data-id");
        if (mm) ouvrirFormulaire(mm, null, pre);
        break;
      }
      case "modifier":
        if (m) ouvrirFormulaire(m, ficheDe(m.cle, el.getAttribute("data-id")));
        break;
      case "supprimer":
        if (m) supprimer(m, el.getAttribute("data-id"));
        break;
      case "exporter":
        if (m) exporter(m);
        break;
      case "effacer-filtres":
        etat.filtres = {}; etat.recherche = ""; etat.page = 0;
        rafraichir();
        break;
      case "fermer":
        fermerFenetre();
        break;
      case "confirmer": {
        document.getElementById("confirmation").hidden = true;
        var faire = aConfirmer;
        aConfirmer = null;
        if (faire) faire();
        break;
      }
      case "annuler-confirmation":
        document.getElementById("confirmation").hidden = true;
        aConfirmer = null;
        break;
      case "menu":
        etat.menuOuvert = !etat.menuOuvert;
        document.body.classList.toggle("menu-ouvert", etat.menuOuvert);
        break;
      case "exemples":
        demanderConfirmation("Remettre les données d'exemple ? Tout ce qui a été saisi sera remplacé.", function () {
          donnees = exemples();
          enregistrerTout();
          etat.choisie = null;
          rafraichir();
          annoncer("Données d'exemple remises.");
        });
        break;
    }
  });

  document.addEventListener("change", function (e) {
    var el = e.target;
    if (el.getAttribute && el.getAttribute("data-action") === "filtre") {
      etat.filtres[el.getAttribute("data-champ")] = el.value;
      etat.page = 0;
      etat.choisie = null;
      rafraichir();
    }
  });

  document.addEventListener("input", function (e) {
    var el = e.target;
    if (el.getAttribute && el.getAttribute("data-action") === "rechercher") {
      etat.recherche = el.value;
      etat.page = 0;
      rafraichir();
      var champ = document.querySelector('[data-action="rechercher"]');
      if (champ) { champ.focus(); champ.setSelectionRange(champ.value.length, champ.value.length); }
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!document.getElementById("confirmation").hidden) { document.getElementById("confirmation").hidden = true; aConfirmer = null; }
    else if (!fenetre.hidden) fermerFenetre();
  });

  /* ---------------- Démarrage ---------------- */
  recalculer();
  document.getElementById("marque-nom").textContent = PLAN.nom;
  document.title = PLAN.nom;
  document.getElementById("aujourdhui").textContent = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  rafraichir();
})();
