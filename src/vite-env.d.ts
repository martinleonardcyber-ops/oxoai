/// <reference types="vite/client" />

/** Version de package.json, injectée par Vite à la construction. */
declare const __OXOAI_VERSION__: string;

interface ImportMetaEnv {
  /** URL de la passerelle modèles (défaut : proxy Vite « /api »). */
  readonly VITE_GATEWAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.png" {
  const src: string;
  export default src;
}

// Module de travail de pdf.js, chargé dans la page (voir src/lib/documents.ts).
declare module "pdfjs-dist/build/pdf.worker.min.mjs";
