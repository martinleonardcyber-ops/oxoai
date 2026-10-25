import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";

/*
 * Version affichée dans l'application, lue dans package.json à la construction.
 * Elle était écrite en dur dans branding.ts et n'a jamais suivi : l'application
 * annonçait v0.4.17 alors qu'elle en était à la 0.7.2. Une seule source, donc.
 */
const { version } = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as {
  version: string;
};

/**
 * Politique de sécurité du contenu de l'application livrée.
 *
 * Posée dans la page elle-même, et non par un en-tête : l'application
 * empaquetée charge `index.html` depuis le disque, et les requêtes `file:`
 * ne passent pas par `webRequest` d'Electron. Un en-tête posé là ne
 * s'appliquait donc à rien (l'en-tête reste par ailleurs, pour le cas où
 * l'interface est servie en HTTP).
 *
 * `connect-src` garde `https:` ouvert : l'adresse de l'instance est celle du
 * serveur du client, saisie à la mise en route, inconnue à la construction.
 * La boucle locale est nommée pour la passerelle du poste. `http:` distant a
 * disparu : un poste ne parle plus à une instance en clair (lib/instance.ts).
 */
const POLITIQUE = [
  "default-src 'self'",
  "script-src 'self'",
  // Les styles compilés sont injectés dans la page par le bundle.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: data:",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:* blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  /*
   * Pas de `frame-ancestors` ici : le navigateur l'ignore dans une balise
   * `meta` et écrit un avertissement dans la console à chaque ouverture. Il
   * reste dans l'en-tête posé par Electron, où il s'applique vraiment.
   */
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

/**
 * Insère cette politique dans la page construite. En développement, rien :
 * le serveur Vite injecte ses propres scripts en ligne et recompile à chaud.
 */
const politiqueDeContenu = () => ({
  name: "oxoai-csp",
  transformIndexHtml: {
    order: "post" as const,
    handler(html: string, ctx: { server?: unknown }) {
      if (ctx.server) return html;
      // Après la déclaration de jeu de caractères, qui doit rester en tête.
      return html.replace(
        /(<meta charset=[^>]*>)/i,
        `$1\n    <meta http-equiv="Content-Security-Policy" content="${POLITIQUE}" />`,
      );
    },
  },
});

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), politiqueDeContenu()],
  // Chemins relatifs : l'application empaquetée charge index.html depuis le
  // disque (file://), où les chemins absolus ne résoudraient pas.
  base: "./",
  define: {
    __OXOAI_VERSION__: JSON.stringify(version),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Passerelle modèles OxoAI (voir gateway/). Évite toute question de CORS
      // et reproduit le chemin qu'aura l'application empaquetée.
      "/api": {
        target: process.env.OXOAI_GATEWAY_URL ?? "http://localhost:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
