// Page du Chat OxoAI dans VS Code. Aucun appel réseau ici : tout passe par l'extension.
(() => {
  const vscode = acquireVsCodeApi();
  const fil = document.getElementById("fil");
  const saisie = document.getElementById("saisie");
  const joindre = document.getElementById("joindre");
  const envoyer = document.getElementById("envoyer");
  let enCours = null;
  let texteEnCours = "";
  /** Début de la réflexion du modèle, pour dire depuis combien de temps il réfléchit. */
  let reflexionDepuis = 0;
  /** Arrivée du premier morceau de la réponse : une réflexion requalifiée commence là. */
  let premierMorceau = 0;
  /** « chat » : le Chat de l'instance ; « code » : OxoAI Code sur le dossier ouvert. */
  let mode = "chat";
  const ongletChat = document.getElementById("onglet-chat");
  const ongletCode = document.getElementById("onglet-code");
  const choisir = (m) => {
    mode = m;
    ongletChat.setAttribute("aria-selected", String(m === "chat"));
    ongletCode.setAttribute("aria-selected", String(m === "code"));
    saisie.placeholder = m === "code" ? "Demandez à OxoAI Code de modifier le projet…" : "Demandez à OxoAI…";
    joindre.parentElement.style.visibility = m === "code" ? "hidden" : "visible";
  };
  ongletChat.addEventListener("click", () => choisir("chat"));
  ongletCode.addEventListener("click", () => choisir("code"));

  const echapper = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  /** Rendu simple : blocs de code (avec bouton « Insérer »), code en ligne, gras. Jamais de HTML venu du modèle. */
  function rendu(texte) {
    const morceaux = texte.split(/```(\w*)\n?([\s\S]*?)(?:```|$)/g);
    let html = "";
    for (let i = 0; i < morceaux.length; i += 3) {
      html += echapper(morceaux[i])
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br>");
      if (morceaux[i + 2] !== undefined) {
        html += `<div class="bloc"><button class="inserer" type="button">Insérer</button><pre><code>${echapper(morceaux[i + 2])}</code></pre></div>`;
      }
    }
    return html;
  }

  function ajouter(classe, html) {
    fil.querySelector(".accueil")?.remove();
    const div = document.createElement("div");
    div.className = `message ${classe}`;
    div.innerHTML = html;
    fil.appendChild(div);
    fil.scrollTop = fil.scrollHeight;
    return div;
  }

  function occupe(oui) {
    envoyer.textContent = oui ? "Arrêter" : "Envoyer";
    envoyer.classList.toggle("arreter", oui);
  }

  document.getElementById("formulaire").addEventListener("submit", (e) => {
    e.preventDefault();
    if (enCours) return vscode.postMessage({ type: "arreter" });
    const texte = saisie.value.trim();
    if (!texte) return;
    saisie.value = "";
    vscode.postMessage(mode === "code" ? { type: "code", texte } : { type: "question", texte, joindre: joindre.checked });
  });
  saisie.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("formulaire").requestSubmit();
    }
  });
  document.getElementById("nouveau").addEventListener("click", () => vscode.postMessage({ type: "nouveau" }));
  fil.addEventListener("click", (e) => {
    const bouton = e.target.closest(".inserer");
    if (bouton) vscode.postMessage({ type: "inserer", texte: bouton.nextElementSibling.textContent });
    if (e.target.closest(".connexion")) vscode.postMessage({ type: "connexion" });
  });

  window.addEventListener("message", ({ data: m }) => {
    if (m.type === "question") {
      // Mise en forme comme les réponses : le code d'une question (« Améliorer la sélection ») garde son indentation.
      ajouter("personne", rendu(m.texte) + (m.fichier ? `<span class="piece">${echapper(m.fichier)}</span>` : ""));
      texteEnCours = "";
      reflexionDepuis = 0;
      enCours = ajouter("oxoai attente", "…");
      occupe(true);
    } else if (m.type === "reflexion" && enCours?.classList.contains("attente")) {
      if (!reflexionDepuis) reflexionDepuis = Date.now();
      const s = Math.round((Date.now() - reflexionDepuis) / 1000);
      enCours.textContent = s < 2 ? "Le modèle réfléchit…" : `Le modèle réfléchit (${s} s)…`;
    } else if (m.type === "requalifier" && enCours) {
      // La réflexion du modèle était arrivée comme réponse (`</think>` seul, 29/09/2026) : retirée, l'attente reprend.
      texteEnCours = texteEnCours.slice(0, Math.max(0, texteEnCours.length - m.caracteres));
      if (texteEnCours.trim()) enCours.innerHTML = rendu(texteEnCours);
      else {
        enCours.classList.add("attente");
        // Elle a commencé avec le premier morceau reçu, pas maintenant.
        if (!reflexionDepuis) reflexionDepuis = premierMorceau || Date.now();
        const s = Math.round((Date.now() - reflexionDepuis) / 1000);
        enCours.textContent = s < 2 ? "Le modèle réfléchit…" : `Le modèle réfléchit (${s} s)…`;
      }
    } else if (m.type === "morceau" && enCours) {
      if (!texteEnCours) premierMorceau = Date.now();
      texteEnCours += m.texte;
      enCours.classList.remove("attente");
      enCours.innerHTML = rendu(texteEnCours);
      fil.scrollTop = fil.scrollHeight;
    } else if (m.type === "code" && enCours) {
      // OxoAI Code : ses actions s'empilent au-dessus de sa réponse.
      enCours.classList.remove("attente");
      if (enCours.textContent === "…") enCours.innerHTML = "";
      // Le modèle lit la demande, attend son tour ou se charge : une ligne qui se réécrit, retirée dès qu'il répond.
      const statut = enCours.querySelector(".statut");
      if (m.statut !== undefined) {
        if (!m.statut) statut?.remove();
        else if (statut) statut.textContent = m.statut;
        else {
          const p = document.createElement("p");
          p.className = "statut";
          p.textContent = m.statut;
          enCours.insertBefore(p, enCours.querySelector(".reponse"));
        }
        fil.scrollTop = fil.scrollHeight;
        return;
      }
      statut?.remove();
      if (m.type === "code" && m.texte !== undefined && m.outil === undefined && m.ok === undefined) {
        texteEnCours += (texteEnCours ? "\n\n" : "") + m.texte;
        let zone = enCours.querySelector(".reponse");
        if (!zone) {
          zone = document.createElement("div");
          zone.className = "reponse";
          enCours.appendChild(zone);
        }
        zone.innerHTML = rendu(texteEnCours);
      } else if (m.outil) {
        const ligne = document.createElement("p");
        ligne.className = "action encours";
        ligne.textContent = m.outil;
        enCours.insertBefore(ligne, enCours.querySelector(".reponse"));
      } else if (m.ok !== undefined) {
        const derniere = [...enCours.querySelectorAll(".action.encours")].pop();
        if (derniere) derniere.className = `action ${m.ok ? "reussie" : "ratee"}`;
      }
      fil.scrollTop = fil.scrollHeight;
    } else if (m.type === "fin" || m.type === "erreur") {
      if (m.type === "erreur" && enCours) {
        // « … » ou « Le modèle réfléchit » : remplacé par l'erreur.
        if (enCours.classList.contains("attente")) enCours.innerHTML = "";
        enCours.classList.remove("attente");
        const p = document.createElement("p");
        p.className = "erreur";
        p.innerHTML = echapper(m.texte) + (/connectez-vous/i.test(m.texte) ? ` <button type="button" class="connexion">Se connecter</button>` : "");
        enCours.appendChild(p);
      }
      enCours = null;
      occupe(false);
      saisie.focus();
    } else if (m.type === "vider") {
      fil.innerHTML = "";
      enCours = null;
      occupe(false);
    }
  });
})();
