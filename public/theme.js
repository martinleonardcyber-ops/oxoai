/*
 * Pose le thème retenu au chargement précédent, avant le premier rendu.
 *
 * Sans cela, l'application s'ouvre en clair puis vire au sombre : un éclair
 * blanc en pleine nuit, exactement ce que le thème évite. Le calcul réel
 * (coucher du soleil, réglage système) a lieu ensuite ; il ne fait que
 * confirmer, ou corriger sans que l'oeil le remarque.
 *
 * Fichier à part, et non script en ligne dans index.html : la politique de
 * sécurité du contenu interdit le script en ligne, et une exception ouverte
 * pour ces quatre lignes vaudrait pour tout le reste.
 */
try {
  var t = localStorage.getItem("oxoai:apparence-resolue");
  if (t === "sombre" || t === "clair") document.documentElement.dataset.theme = t;
} catch (e) {
  /* stockage indisponible : le thème se posera au premier rendu */
}
