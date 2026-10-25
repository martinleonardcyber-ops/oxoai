import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, totalmem } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { detectHardware, type Hardware } from "./provision.ts";
import { findLms, libererPourImage, loadModel } from "./backends.ts";
import { dossierLmStudio as dossierDeLmStudio, dossierTelechargementsLmStudio } from "./engine.ts";
import { models } from "./router.ts";
import { telecharger } from "./images.ts";
import { completer } from "./completion.ts";
import { journaliser } from "./audit.ts";
import { chiffrerOctets, dechiffrerOctets } from "./secret.ts";
import { t, tf } from "./langue.ts";
import empreintesPaquets from "./entrainement-paquets.json" with { type: "json" };
import { arreterArbre } from "./processus.ts";
import { assurerPythonPrive, pythonPrive, pythonPriveInstallable, tarDuSysteme } from "./pythonPrive.ts";

const exec = promisify(execFile);

/**
 * Entraîner un modèle sur ses propres exemples, sur la machine.
 *
 * Ce que la personne veut : « que le modèle sache des choses précises » (les
 * produits de la maison, ses procédures, sa façon de répondre). Ce que cela
 * demande : un réglage fin par LoRA, c'est-à-dire quelques millions de poids
 * ajoutés à un petit modèle ouvert, appris sur ses exemples, puis fondus dans
 * le modèle et rangés dans LM Studio, où le sélecteur de modèles le trouve.
 *
 * ── Deux moteurs, selon la machine ──────────────────────────────────────────
 *
 * - **Mac à puce Apple** : MLX-LM (Apple, licence MIT), `mlx_lm lora` puis
 *   `mlx_lm fuse`. C'est aussi ce qu'Unsloth utilise lui-même sur Mac : relevé
 *   le 25/09/2026 dans l'application Unsloth du poste (0.1.808-beta), son
 *   environnement porte mlx 0.32.1 et mlx-lm 0.31.3, et son journal dit
 *   « Hardware detected: MLX ». Passer par Unsloth n'apporterait donc rien
 *   sur Mac, sinon une dépendance de plus. **Vérifié** sur ce poste (M4, 16 Go).
 * - **PC avec carte NVIDIA** : QLoRA avec les bibliothèques de Hugging Face
 *   (transformers, peft, bitsandbytes : Apache 2.0 et MIT). Unsloth irait
 *   environ deux fois plus vite avec la même méthode, mais il tire
 *   `unsloth_zoo`, sous LGPL-3.0 (relevé dans ses métadonnées le 25/09/2026) :
 *   hors de la règle du projet (Apache 2.0 ou MIT), à trancher par le client
 *   avant de l'adopter. **Pas vérifié** : aucune machine NVIDIA sous la main.
 *   Seule la dernière étape (conversion GGUF par llama.cpp, chargement par
 *   LM Studio) a été essayée, sur le Mac, avec un modèle entraîné par MLX.
 * - Ailleurs (Mac Intel, PC sans carte NVIDIA) : on le dit, sans rien
 *   installer. Au processeur, un entraînement se compte en jours.
 *
 * ── Garde-fous ──────────────────────────────────────────────────────────────
 *
 * - Toutes les routes exigent une séance ; un projet n'est vu que de son auteur.
 * - Les paquets Python sont figés et vérifiés par empreinte (`pip
 *   --require-hashes`, entrainement-paquets.json) sur Mac ; les fichiers du
 *   modèle de base sont pris à une révision précise et vérifiés par empreinte.
 * - Les scripts Python sont des constantes de ce module, lancés par `spawn`
 *   avec un tableau d'arguments, jamais par un shell ; l'interpréteur tourne en
 *   mode isolé (`-I`), hors ligne une fois installé (`HF_HUB_OFFLINE`).
 * - Les exemples ne vont que dans des fichiers : aucun ne devient un argument
 *   de commande. Le projet est chiffré au repos comme la bibliothèque ; les
 *   fichiers d'entraînement en clair n'existent que le temps du calcul.
 * - Un seul travail lourd à la fois sur la machine.
 * - Avant d'entraîner, les modèles de LM Studio **au repos** sont déchargés
 *   (jamais un modèle en train de répondre) ; à la fermeture de la passerelle,
 *   un entraînement en cours est arrêté.
 */

/* ------------------------------------------------------------------ */
/* Modèles de base                                                     */
/* ------------------------------------------------------------------ */

interface FichierBase {
  chemin: string;
  taille: number;
  sha256: string;
}

export type CleBase = "qwen3-0.6b" | "qwen3-1.7b" | "qwen3-4b-2507";

interface ModeleBase {
  cle: CleBase;
  nom: string;
  depot: string;
  revision: string;
  fichiers: FichierBase[];
  /** Octets des poids, pour estimer la mémoire et le disque. */
  poids: number;
  /** Essayé de bout en bout avec OxoAI, sur une machine réelle. */
  verifie: boolean;
  /** Pas d'entraînement mesuré par seconde (batch de 4), sur un Mac M4 de 16 Go. */
  pasParSeconde: number;
}

/*
 * Empreintes relevées le 25/09/2026 : celles des poids sont publiées par
 * Hugging Face (fichiers LFS) et ont été recalculées au téléchargement ; celles
 * des petits fichiers ont été calculées sur les fichiers téléchargés à la même
 * révision. Les trois dépôts sont sous licence Apache 2.0, publiés par Qwen.
 */
const LICENCE: FichierBase = { chemin: "LICENSE", taille: 11_343, sha256: "832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e" };
const TOKENIZER: FichierBase = { chemin: "tokenizer.json", taille: 11_422_654, sha256: "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4" };
const VOCAB: FichierBase = { chemin: "vocab.json", taille: 2_776_833, sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910" };
const MERGES_QWEN3: FichierBase = { chemin: "merges.txt", taille: 1_671_853, sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5" };
const GENERATION_QWEN3: FichierBase = { chemin: "generation_config.json", taille: 239, sha256: "2325da0f15bb848e018c5ae071b7943332e9f871d6b60e2ed22ca97d4cb993d2" };
const TOKENIZER_CONFIG_QWEN3: FichierBase = { chemin: "tokenizer_config.json", taille: 9_732, sha256: "d5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101" };

const BASES: ModeleBase[] = [
  {
    cle: "qwen3-0.6b",
    nom: "Qwen3 0.6B",
    depot: "Qwen/Qwen3-0.6B",
    revision: "c1899de289a04d12100db370d81485cdf75e47ca",
    poids: 1_503_300_328,
    verifie: false,
    // Estimation, pas une mesure : trois fois moins de poids que le 1.7B.
    pasParSeconde: 2.2,
    fichiers: [
      LICENCE, TOKENIZER, VOCAB, MERGES_QWEN3, GENERATION_QWEN3, TOKENIZER_CONFIG_QWEN3,
      { chemin: "config.json", taille: 726, sha256: "660db3b73d788119c04535e48cf9be5f55bc3100841a718637ae695b442f27dd" },
      { chemin: "model.safetensors", taille: 1_503_300_328, sha256: "f47f71177f32bcd101b7573ec9171e6a57f4f4d31148d38e382306f42996874b" },
    ],
  },
  {
    cle: "qwen3-1.7b",
    nom: "Qwen3 1.7B",
    depot: "Qwen/Qwen3-1.7B",
    revision: "70d244cc86ccca08cf5af4e1e306ecf908b1ad5e",
    poids: 4_063_515_592,
    verifie: true,
    // Mesuré le 25/09/2026 : 0,93 pas par seconde, 60 exemples courts dont 30 d'ancrage (voir `reglages`).
    pasParSeconde: 0.93,
    fichiers: [
      LICENCE, TOKENIZER, VOCAB, MERGES_QWEN3, GENERATION_QWEN3, TOKENIZER_CONFIG_QWEN3,
      { chemin: "config.json", taille: 726, sha256: "1ddb5b89ebc90dcb417a45c213d818577e65976454d29385c8f6140771d95197" },
      { chemin: "model.safetensors.index.json", taille: 25_605, sha256: "0d660e94b165eb912669a5249dff44b83188c4777a07ddb9611fb78d91b0578d" },
      { chemin: "model-00001-of-00002.safetensors", taille: 3_441_185_608, sha256: "169ad53ec313c3a34b06c0809216e4fc072cce444a5d4ff2b59690d064130ed5" },
      { chemin: "model-00002-of-00002.safetensors", taille: 622_329_984, sha256: "912becff8d60672aa8628ef08c05898d9adf17c2ad4ae3caf99b065622fdeff9" },
    ],
  },
  {
    /*
     * Pas de version « 2507 » du 1.7B : le 4B-Instruct-2507 est le plus petit
     * modèle Qwen3 qui ne raisonne pas avant de répondre, ce qui convient
     * mieux à des réponses apprises. Pour les grosses machines seulement.
     */
    cle: "qwen3-4b-2507",
    nom: "Qwen3 4B Instruct 2507",
    depot: "Qwen/Qwen3-4B-Instruct-2507",
    revision: "cdbee75f17c01a7cc42f958dc650907174af0554",
    poids: 8_044_982_000,
    verifie: false,
    // Estimation, pas une mesure : deux fois plus de poids que le 1.7B.
    pasParSeconde: 0.4,
    fichiers: [
      LICENCE, TOKENIZER, VOCAB,
      { chemin: "merges.txt", taille: 1_671_839, sha256: "599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3" },
      { chemin: "generation_config.json", taille: 238, sha256: "835fffe355c9438e7a25be099b3fccaa98350b83451f9fd2d99512e74f1ade48" },
      { chemin: "tokenizer_config.json", taille: 9_377, sha256: "a62ff0a2472a0fa1b8eaabcb57c59b58afa42a22831dc141400b6e0cf2b65ce3" },
      { chemin: "config.json", taille: 727, sha256: "5beea1a4a34c62782bfb2f911c606741a3bab8f92d80a118fa053c28af12e8ba" },
      { chemin: "model.safetensors.index.json", taille: 32_819, sha256: "d6c42883a895dfef5b0080ed2116a1bcd764f558406b98923d675978a1abf29c" },
      { chemin: "model-00001-of-00003.safetensors", taille: 3_957_900_840, sha256: "75311d91bb08cf0b882913da464a1e722a31fb44db35208663487efb7a3d8ed6" },
      { chemin: "model-00002-of-00003.safetensors", taille: 3_987_450_520, sha256: "0b48adbb1f60e901153d91907ba11ce63bd4b8b584482e730f48808d055dfba1" },
      { chemin: "model-00003-of-00003.safetensors", taille: 99_630_640, sha256: "7dd39ccca5e4de123c74c14af44c9bf2eb75df33b4614382af0134528e060d5d" },
    ],
  },
];

const base = (cle: string) => BASES.find((b) => b.cle === cle);
const go = (octets: number) => Math.round((octets / 1e9) * 10) / 10;

/* ------------------------------------------------------------------ */
/* Moteurs                                                             */
/* ------------------------------------------------------------------ */

type IdMoteur = "mlx" | "nvidia";

/**
 * Paquets du moteur NVIDIA, figés à la version. Pas d'empreintes ici : les
 * roues de PyTorch pour CUDA viennent de son propre dépôt, et sans machine
 * NVIDIA on ne peut ni les relever ni les essayer. transformers reste en 4.57
 * parce que le convertisseur GGUF de llama.cpp l'exige (ses requirements).
 */
const PAQUETS_NVIDIA = [
  "torch==2.11.0",
  "transformers==4.57.6",
  "peft==0.21.0",
  "accelerate==1.15.0",
  "bitsandbytes==0.50.2",
  "safetensors==0.8.0",
  "sentencepiece==0.2.2",
  "numpy~=2.2.6",
  "protobuf>=4.21.0,<5.0.0",
  "pyyaml==6.0.3",
];
const INDEX_TORCH_CUDA = "https://download.pytorch.org/whl/cu128";

/*
 * Unsloth sur carte NVIDIA, décidé par Medhi le 25/09/2026 : même méthode
 * (QLoRA 4 bits), environ deux fois plus rapide et moins gourmand en mémoire
 * graphique d'après ses auteurs. Le cœur est Apache 2.0 ; `unsloth_zoo`, dont
 * il dépend, est LGPL-3.0-or-later : utilisée comme bibliothèque, dans un
 * environnement Python séparé et non modifiée, elle est compatible avec
 * l'AGPL du projet (exception faite à la règle « Apache 2.0 ou MIT », notée
 * dans PROJET.md § 3.12). Sur Mac, Unsloth passe lui-même par MLX : on garde
 * MLX-LM directement.
 *
 * Les deux roues sont téléchargées par OxoAI et vérifiées par empreinte
 * (relevées sur PyPI le 25/09/2026), puis installées depuis le disque ; leurs
 * dépendances (trl, datasets, xformers, triton...) viennent de PyPI sans
 * empreinte, comme le reste de la pile NVIDIA. Compatibles avec les versions
 * figées ci-dessus : torch <2.13, transformers 4.57.6 admis, peft >=0.18.
 *
 * Si Unsloth ne s'installe pas ou ne se charge pas (carte trop ancienne,
 * pilote), l'entraînement repasse par transformers et peft seuls : rien n'est
 * perdu. Jamais essayé sur une vraie machine NVIDIA.
 */
const UNSLOTH = [
  {
    fichier: "unsloth-2026.9.11-py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/86/ae/d5cfe04b4eb6c3fb3a3e98ec02405a75adca697b14d9ce52816bc3369b1b/unsloth-2026.9.11-py3-none-any.whl",
    sha256: "3cf44a2adfd3267cb1bb4c6c73442cfc9915cc3232f32c9872295c3a273ed21c",
    taille: 24_382_135,
  },
  {
    fichier: "unsloth_zoo-2026.9.7-py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/5f/fb/c23a8ccb271bb094ae7d1d073e6772099547ef1f146e3246e7416dae284c/unsloth_zoo-2026.9.7-py3-none-any.whl",
    sha256: "cbfe5f9d22a65e45725929443202cb7d6634d33f0e15d29f17c16ae5b679658d",
    taille: 1_795_255,
  },
];

/**
 * llama.cpp (MIT) sert seulement à convertir le modèle fini en GGUF, le format
 * que LM Studio charge sous Windows et Linux. Source à une version précise,
 * archive vérifiée par empreinte (relevée le 25/09/2026).
 */
const LLAMACPP = {
  version: "v0.5.0",
  archive: "https://github.com/ggml-org/llama.cpp/archive/refs/tags/v0.5.0.tar.gz",
  sha256: "fef9ed754f4e031fb5c663c29260feda4ebc241abb68d64a81c0f1df5f1748e2",
  taille: 37_561_391,
  dossier: "llama.cpp-0.5.0",
};

/** Place prise par l'environnement Python une fois installé, mesurée (Mac) ou estimée (NVIDIA). */
const TAILLE_ENVIRONNEMENT = { mlx: 435e6, nvidia: 6e9 } as const;

interface Capacite {
  possible: boolean;
  moteur: IdMoteur | null;
  /** Pourquoi c'est possible ou non, en clair. */
  raison: string;
  base: ModeleBase | null;
  verifie: boolean;
}

async function versionMac(): Promise<number | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await exec("sw_vers", ["-productVersion"], { timeout: 5000 });
    return Number(stdout.trim().split(".")[0]) || null;
  } catch {
    return null;
  }
}

/**
 * Le moteur et le modèle de base qui conviennent à cette machine.
 *
 * Mac : mesuré le 25/09/2026, Qwen3 1.7B occupe 6,3 Go au plus fort de
 * l'entraînement (7,1 Go pour tout le processus), pour 4,1 Go de poids. D'où
 * 16 Go pour le 1.7B, 32 Go pour le 4B (8 Go de poids), 8 Go pour le 0.6B.
 * PC : QLoRA charge le modèle en 4 bits, environ 2 Go de carte pour le 1.7B
 * et 4 Go pour le 4B, activations en plus ; seuils pris avec de la marge.
 */
function capaciteDe(hw: Hardware, mac: number | null): Capacite {
  if (hw.platform === "darwin") {
    if (!hw.appleSilicon) {
      return { possible: false, moteur: null, base: null, verifie: false, raison: t("Ce Mac a un processeur Intel : l'entraînement demande une puce Apple (M1 ou plus récente) ou une carte graphique NVIDIA.") };
    }
    if ((mac ?? 0) < 14) {
      return { possible: false, moteur: null, base: null, verifie: false, raison: t("Il faut macOS 14 ou plus récent pour entraîner un modèle sur ce Mac.") };
    }
    const m = hw.totalMemoryGb >= 32 ? base("qwen3-4b-2507") : hw.totalMemoryGb >= 16 ? base("qwen3-1.7b") : hw.totalMemoryGb >= 8 ? base("qwen3-0.6b") : undefined;
    if (!m) return { possible: false, moteur: "mlx", base: null, verifie: false, raison: tf("{0} Go de mémoire : il en faut 8 au moins pour entraîner un modèle.", hw.totalMemoryGb) };
    return {
      possible: true,
      moteur: "mlx",
      base: m,
      verifie: m.verifie,
      // La règle dite à l'écran : « c'est pas adaptatif ? » (Medhi, 27/09/2026), alors qu'elle l'est.
      raison: tf("Mac à puce Apple, {0} Go de mémoire : {1}, entraîné par MLX sur la puce graphique. Choisi selon la mémoire : Qwen3 0.6B dès 8 Go, 1.7B dès 16 Go, 4B dès 32 Go.", hw.totalMemoryGb, m.nom),
    };
  }
  const vram = hw.gpuVramGb ?? 0;
  if ((hw.platform === "win32" || hw.platform === "linux") && hw.arch === "x64" && vram >= 6) {
    const m = vram >= 12 ? base("qwen3-4b-2507")! : base("qwen3-1.7b")!;
    return {
      possible: true,
      moteur: "nvidia",
      base: m,
      verifie: false,
      raison: tf("Carte NVIDIA de {0} Go : {1}, entraîné en QLoRA par Unsloth (transformers et peft en repli). Choisi selon la mémoire de la carte : Qwen3 1.7B dès 6 Go, 4B dès 12 Go.", vram, m.nom),
    };
  }
  if (vram > 0) {
    return { possible: false, moteur: null, base: null, verifie: false, raison: tf("Carte NVIDIA de {0} Go : il en faut 6 au moins pour entraîner un modèle.", vram) };
  }
  return {
    possible: false,
    moteur: null,
    base: null,
    verifie: false,
    raison: t("Pas de puce Apple ni de carte graphique NVIDIA sur cette machine : au processeur seul, un entraînement prendrait des jours. Ce n'est pas proposé."),
  };
}

/* ------------------------------------------------------------------ */
/* Emplacements                                                        */
/* ------------------------------------------------------------------ */

/**
 * Le moteur (venv, modèles de base) vit à côté de l'atelier ; les projets,
 * qui portent les exemples de quelqu'un, avec les données de l'instance.
 * `OXOAI_DATA_DIR` prime pour les deux, comme dans atelier.ts : un essai ne
 * touche rien de la machine.
 */
const racineMoteur = () =>
  process.env.OXOAI_DATA_DIR ? join(process.env.OXOAI_DATA_DIR, "entrainement-moteur") : join(homedir(), ".oxoai", "entrainement");
const dossierPython = () => join(racineMoteur(), "python");
const dossierBases = () => join(racineMoteur(), "modeles");
const dossierBase = (b: ModeleBase) => join(dossierBases(), b.cle);
const dossierLlamaCpp = () => join(racineMoteur(), "llama.cpp", LLAMACPP.dossier);
const temoin = () => join(racineMoteur(), "pret.json");
const dossierProjets = () => join(process.env.OXOAI_DATA_DIR ?? join(homedir(), ".oxoai", "data"), "entrainement");
const dossierProjet = (id: string) => join(dossierProjets(), id);

const pythonVenv = () =>
  process.platform === "win32" ? join(dossierPython(), "Scripts", "python.exe") : join(dossierPython(), "bin", "python3");

/**
 * Dossier des modèles de LM Studio : celui que ses réglages désignent, sinon
 * l'emplacement par défaut. Les modèles entraînés vont dans un « éditeur » à
 * part, `oxoai-entrainement`, pour qu'on ne retire jamais que les nôtres.
 */
const EDITEUR_LMSTUDIO = "oxoai-entrainement";
function dossierLmStudio(): string {
  const force = process.env.OXOAI_LMSTUDIO_MODELES;
  if (force) return force;
  /*
   * Le dossier de LM Studio que suit la passerelle (engine.ts), pointeur
   * compris : depuis le 28/09/2026, il peut être sur un autre disque. Avant,
   * `~/.lmstudio` était écrit ici en dur.
   */
  const reglage = dossierTelechargementsLmStudio();
  if (reglage && existsSync(reglage)) return reglage;
  return join(dossierDeLmStudio(), "models");
}
const dossierNosModeles = () => join(dossierLmStudio(), EDITEUR_LMSTUDIO);

/** `chemin` est-il bien sous `parent` ? Garde avant toute suppression. */
function sous(parent: string, chemin: string): boolean {
  const p = resolve(parent) + sep;
  return resolve(chemin).startsWith(p);
}

/* ------------------------------------------------------------------ */
/* Travail en cours (un seul à la fois sur la machine)                 */
/* ------------------------------------------------------------------ */

type TypeTravail = "installation" | "generation" | "entrainement" | "comparaison" | "publication";

export interface Travail {
  type: TypeTravail;
  pour: string;
  projet?: string;
  message: string;
  /** Avancement : octets, pas d'entraînement ou morceaux de document. */
  fait: number;
  total: number;
  debut: number;
  /** Entraînement : dernière perte mesurée, sur les exemples appris et sur ceux mis de côté. */
  perte?: number;
  perteValidation?: number;
  /** Secondes restantes, d'après la vitesse mesurée. */
  resteSecondes?: number;
  memoireGo?: number;
}

let travail: Travail | null = null;
let processus: ChildProcess | null = null;
let arretDemande = false;
/** Dernière erreur d'installation du moteur, pour l'écran. */
let erreurInstallation: string | null = null;

function occuper(nouveau: Omit<Travail, "debut" | "fait" | "total"> & Partial<Pick<Travail, "fait" | "total">>): Travail {
  if (travail) {
    throw new ErreurEntrainement(409, t("Un travail d'entraînement occupe déjà la machine : attendez qu'il se termine."));
  }
  travail = { fait: 0, total: 0, ...nouveau, debut: Date.now() };
  arretDemande = false;
  return travail;
}

function liberer(): void {
  travail = null;
  processus = null;
  arretDemande = false;
}

/** Erreur destinée à l'écran, avec son code HTTP. */
export class ErreurEntrainement extends Error {
  readonly statut: number;
  constructor(statut: number, message: string) {
    super(message);
    this.statut = statut;
  }
}

/* ------------------------------------------------------------------ */
/* Processus Python                                                    */
/* ------------------------------------------------------------------ */

/**
 * Environnement des processus : réduit, comme celui de la dictée. Une fois le
 * moteur installé, Hugging Face est interdit de réseau : le modèle se charge
 * depuis son dossier, rien ne part.
 */
function environnement(horsLigne = true): NodeJS.ProcessEnv {
  const reduit: NodeJS.ProcessEnv =
    process.platform === "win32"
      ? { ...process.env }
      : {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? homedir(),
          ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        };
  return {
    ...reduit,
    HF_HOME: join(racineMoteur(), "hf"),
    HF_HUB_DISABLE_TELEMETRY: "1",
    HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
    TOKENIZERS_PARALLELISM: "false",
    PYTHONUNBUFFERED: "1",
    // Le cache de pip grossirait le disque de quelqu'un qui en manque déjà.
    PIP_NO_CACHE_DIR: "1",
    PIP_NO_INPUT: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    ...(horsLigne ? { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } : {}),
  };
}

/**
 * Lance un programme et suit sa sortie ligne à ligne. Retient les dernières
 * lignes : c'est là qu'est la raison d'un échec. Le processus est gardé pour
 * pouvoir l'arrêter (bouton « Arrêter », fermeture de la passerelle).
 */
function lancer(
  commande: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; delai?: number; onLigne?: (ligne: string) => void } = {},
): Promise<string> {
  return new Promise((ok, ko) => {
    const enfant = spawn(commande, args, {
      cwd: options.cwd,
      env: options.env ?? environnement(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    processus = enfant;
    let tout = "";
    let reste = "";
    const lire = (morceau: Buffer) => {
      const texte = morceau.toString("utf8");
      tout = (tout + texte).slice(-200_000);
      reste += texte;
      // `\r` aussi : les barres de progression réécrivent leur ligne en place.
      const lignes = reste.split(/[\r\n]/);
      reste = lignes.pop() ?? "";
      for (const l of lignes) if (l.trim()) options.onLigne?.(l.trim());
    };
    enfant.stdout?.on("data", lire);
    enfant.stderr?.on("data", lire);
    const minuterie = setTimeout(() => enfant.kill("SIGKILL"), options.delai ?? 4 * 3_600_000);
    enfant.on("error", (err) => {
      clearTimeout(minuterie);
      if (processus === enfant) processus = null;
      ko(new Error(tf("{0} n'a pas pu être lancé : {1}", basename(commande), err.message)));
    });
    enfant.on("close", (code) => {
      clearTimeout(minuterie);
      if (processus === enfant) processus = null;
      if (reste.trim()) options.onLigne?.(reste.trim());
      if (code === 0) return ok(tout);
      ko(new Error(tout.trim().split("\n").slice(-6).join("\n") || tf("Code de sortie {0}.", String(code))));
    });
  });
}

/** Transforme l'échec d'un processus en phrase qu'une personne peut comprendre. */
function expliquer(err: unknown): string {
  const brut = err instanceof Error ? err.message : String(err);
  if (arretDemande) return t("Arrêté à votre demande.");
  /*
   * Mesuré le 25/09/2026 sur un Mac de 16 Go : Qwen3 8B chargé dans LM Studio
   * avec 28 160 jetons de contexte retient 10,4 Go de mémoire graphique. Quand
   * il répond à quelqu'un, MLX n'obtient plus la sienne et s'arrête sur cette
   * erreur de Metal. Vu aussi le même jour : déchargé avant l'entraînement,
   * il a été rechargé une minute plus tard par un autre programme branché
   * sur LM Studio (qui recharge à la demande), et le calcul s'est arrêté.
   */
  if (/Insufficient Memory|OutOfMemory|out of memory|CUDA out of memory/i.test(brut)) {
    return t("Mémoire insuffisante : un modèle de LM Studio a été chargé ou sollicité pendant le calcul, par un Chat ou par un autre programme. Attendez qu'il ait fini, puis relancez.");
  }
  return brut.split("\n").slice(-3).join(" ").slice(0, 600);
}

const MARQUEUR = "@@OXOAI@@";
function lireMarqueur<T>(sortie: string): T {
  const rang = sortie.lastIndexOf(MARQUEUR);
  if (rang < 0) throw new Error(t("Le calcul n'a rien rendu."));
  return JSON.parse(sortie.slice(rang + MARQUEUR.length).split("\n")[0]!) as T;
}

/* ------------------------------------------------------------------ */
/* Scripts Python (constantes : rien n'y est interpolé)                */
/* ------------------------------------------------------------------ */

/**
 * Réponses d'un modèle à une liste de questions, sans raisonnement, en
 * gourmand (température nulle) : deux passes sur les mêmes questions doivent
 * donner la même chose, sinon la comparaison ne prouve rien.
 * Arguments : modèle, adaptateur (ou chaîne vide), fichier de questions,
 * fichier de sortie, nombre maximal de jetons.
 */
const SCRIPT_MLX_REPONDRE = String.raw`
import json, sys
from mlx_lm import load, generate
from mlx_lm.sample_utils import make_sampler

modele, adaptateur, entree, sortie, jetons = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
questions = json.load(open(entree, encoding="utf-8"))
model, tok = load(modele, adapter_path=adaptateur or None)
reponses = []
for q in questions:
    invite = tok.apply_chat_template([{"role": "user", "content": q}], add_generation_prompt=True, enable_thinking=False, tokenize=False)
    reponses.append(generate(model, tok, invite, max_tokens=jetons, sampler=make_sampler(temp=0.0)).strip())
    json.dump(reponses, open(sortie, "w", encoding="utf-8"), ensure_ascii=False)
    print("@@REPONSE@@" + str(len(reponses)), flush=True)
sys.stdout.write("@@OXOAI@@" + json.dumps({"n": len(reponses)}) + "\n")
`;

/** Essai après installation : les bibliothèques se chargent-elles ? */
const SCRIPT_MLX_ESSAI = String.raw`
import json, sys
import mlx.core as mx
import mlx_lm
sys.stdout.write("@@OXOAI@@" + json.dumps({"mlx": mx.__version__, "mlx_lm": mlx_lm.__version__, "gpu": str(mx.default_device())}) + "\n")
`;

/**
 * NVIDIA : QLoRA avec transformers et peft. **Pas vérifié.** Écrit d'après
 * la documentation de peft (LoRA sur modèle 4 bits, `prepare_model_for_kbit_
 * training`) et de bitsandbytes (NF4, double quantification). La perte ne
 * porte que sur la réponse (le début de la conversation est masqué), comme
 * `--mask-prompt` côté Mac. Chaque journal de l'entraîneur sort sur une ligne
 * `@@PAS@@`, lue par la passerelle.
 * Arguments : modèle, dossier des données, dossier de l'adaptateur, réglages (JSON).
 */
const SCRIPT_NVIDIA_ENTRAINER = String.raw`
import json, sys, math
modele, donnees, sortie, reglages = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
CIBLES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]

# Unsloth d'abord (il doit être importé avant transformers), transformers et peft seuls sinon.
model = None
try:
    from unsloth import FastLanguageModel
    model, tok = FastLanguageModel.from_pretrained(modele, max_seq_length=reglages["longueur"], load_in_4bit=True, dtype=None)
    model = FastLanguageModel.get_peft_model(model, r=reglages["rang"], lora_alpha=reglages["rang"] * 2, lora_dropout=0.0,
        target_modules=CIBLES, use_gradient_checkpointing="unsloth")
    print("@@MOTEUR@@unsloth", flush=True)
except Exception as err:
    print("@@MOTEUR@@peft " + type(err).__name__ + ": " + str(err)[:200], flush=True)
    model = None

import torch
from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig, Trainer, TrainingArguments, TrainerCallback
if model is None:
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    tok = AutoTokenizer.from_pretrained(modele)
if tok.pad_token is None:
    tok.pad_token = tok.eos_token

def lire(nom):
    lignes = []
    try:
        for l in open(f"{donnees}/{nom}", encoding="utf-8"):
            if l.strip():
                lignes.append(json.loads(l)["messages"])
    except FileNotFoundError:
        pass
    return lignes

def encoder(messages):
    debut = tok.apply_chat_template(messages[:-1], add_generation_prompt=True, enable_thinking=False, tokenize=True)
    tout = tok.apply_chat_template(messages, enable_thinking=False, tokenize=True)
    tout = tout[: reglages["longueur"]]
    etiquettes = [-100] * min(len(debut), len(tout)) + tout[len(debut):]
    return {"input_ids": tout, "labels": etiquettes[: len(tout)]}

class Jeu(torch.utils.data.Dataset):
    def __init__(self, conversations):
        self.e = [encoder(m) for m in conversations]
    def __len__(self):
        return len(self.e)
    def __getitem__(self, i):
        return self.e[i]

def assembler(lot):
    n = max(len(x["input_ids"]) for x in lot)
    ids = [x["input_ids"] + [tok.pad_token_id] * (n - len(x["input_ids"])) for x in lot]
    lab = [x["labels"] + [-100] * (n - len(x["labels"])) for x in lot]
    att = [[1] * len(x["input_ids"]) + [0] * (n - len(x["input_ids"])) for x in lot]
    return {"input_ids": torch.tensor(ids), "labels": torch.tensor(lab), "attention_mask": torch.tensor(att)}

if model is None:
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.bfloat16)
    model = AutoModelForCausalLM.from_pretrained(modele, quantization_config=quant, device_map={"": 0}, torch_dtype=torch.bfloat16)
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    model = get_peft_model(model, LoraConfig(r=reglages["rang"], lora_alpha=reglages["rang"] * 2, lora_dropout=0.0, task_type="CAUSAL_LM",
        target_modules=CIBLES))

class Suivi(TrainerCallback):
    def on_log(self, args, state, control, logs=None, **kw):
        logs = logs or {}
        print("@@PAS@@" + json.dumps({"pas": state.global_step, "total": state.max_steps, "perte": logs.get("loss"), "validation": logs.get("eval_loss")}), flush=True)

entrainement, validation = Jeu(lire("train.jsonl")), Jeu(lire("valid.jsonl"))
args = TrainingArguments(output_dir=sortie + "-etapes", per_device_train_batch_size=reglages["lot"], max_steps=reglages["pas"],
    learning_rate=reglages["taux"], logging_steps=5, save_strategy="no", report_to=[], bf16=True, optim="paged_adamw_8bit",
    eval_strategy="steps" if len(validation) else "no", eval_steps=max(10, reglages["pas"] // 4), lr_scheduler_type="constant")
Trainer(model=model, args=args, train_dataset=entrainement, eval_dataset=validation if len(validation) else None, data_collator=assembler, callbacks=[Suivi()]).train()
model.save_pretrained(sortie)
sys.stdout.write("@@OXOAI@@" + json.dumps({"ok": True}) + "\n")
`;

/** NVIDIA : mêmes réponses que SCRIPT_MLX_REPONDRE, par transformers et peft. Pas vérifié. */
const SCRIPT_NVIDIA_REPONDRE = String.raw`
import json, sys, torch
from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
modele, adaptateur, entree, sortie, jetons = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
tok = AutoTokenizer.from_pretrained(modele)
quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16)
model = AutoModelForCausalLM.from_pretrained(modele, quantization_config=quant, device_map={"": 0})
if adaptateur:
    from peft import PeftModel
    model = PeftModel.from_pretrained(model, adaptateur)
reponses = []
for q in json.load(open(entree, encoding="utf-8")):
    ids = tok.apply_chat_template([{"role": "user", "content": q}], add_generation_prompt=True, enable_thinking=False, return_tensors="pt").to(model.device)
    out = model.generate(ids, max_new_tokens=jetons, do_sample=False)
    reponses.append(tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True).strip())
    json.dump(reponses, open(sortie, "w", encoding="utf-8"), ensure_ascii=False)
    print("@@REPONSE@@" + str(len(reponses)), flush=True)
sys.stdout.write("@@OXOAI@@" + json.dumps({"n": len(reponses)}) + "\n")
`;

/** NVIDIA : fond l'adaptateur dans le modèle en 16 bits, pour la conversion GGUF. Pas vérifié. */
const SCRIPT_NVIDIA_FONDRE = String.raw`
import json, sys, torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import PeftModel
modele, adaptateur, sortie = sys.argv[1], sys.argv[2], sys.argv[3]
model = AutoModelForCausalLM.from_pretrained(modele, torch_dtype=torch.float16, device_map={"": "cpu"})
model = PeftModel.from_pretrained(model, adaptateur).merge_and_unload()
model.save_pretrained(sortie, safe_serialization=True)
AutoTokenizer.from_pretrained(modele).save_pretrained(sortie)
sys.stdout.write("@@OXOAI@@" + json.dumps({"ok": True}) + "\n")
`;

/* ------------------------------------------------------------------ */
/* État de la machine                                                  */
/* ------------------------------------------------------------------ */

interface Temoin {
  moteur: IdMoteur;
  base: CleBase;
  date: string;
  versions?: Record<string, string>;
}

function lireTemoin(): Temoin | null {
  try {
    return JSON.parse(readFileSync(temoin(), "utf8")) as Temoin;
  } catch {
    return null;
  }
}

function tailleDossier(dossier: string): number {
  let total = 0;
  try {
    for (const e of readdirSync(dossier, { withFileTypes: true, recursive: true })) {
      if (!e.isFile()) continue;
      const parent = (e as { parentPath?: string }).parentPath ?? dossier;
      try {
        total += statSync(join(parent, e.name)).size;
      } catch {
        /* fichier parti entre-temps */
      }
    }
  } catch {
    /* dossier absent */
  }
  return total;
}

export interface EtatEntrainement {
  possible: boolean;
  raison: string;
  moteur: IdMoteur | null;
  /** Chemin essayé de bout en bout sur une machine réelle. */
  verifie: boolean;
  base: { cle: CleBase; nom: string; depot: string; licence: string; verifie: boolean } | null;
  /** Moteur et modèle de base en place, essai compris. */
  pret: boolean;
  /** Ce qu'il reste à télécharger, et la place prise une fois installé. */
  telechargementGo: number;
  placeGo: number;
  /** Place prise aujourd'hui par le moteur (venv et modèles de base). */
  placeActuelleGo: number;
  obstacles: string[];
  erreurInstallation: string | null;
  /** Le travail en cours ; ses détails seulement pour qui l'a lancé. */
  travail: Travail | { type: TypeTravail; autre: true; message: string } | null;
  projets: ResumeProjet[];
}

/** numpy 2.5, figé pour le Mac, demande Python 3.12 ou plus récent. */
const minimumPython = (moteur: string | null): [number, number] => (moteur === "mlx" ? [3, 12] : [3, 10]);

/**
 * Le Python à partir duquel créer l'environnement d'entraînement : celui du
 * système s'il est assez récent, sinon celui que OxoAI pose (3.12). `installer`
 * seulement à l'installation.
 */
async function pythonPourEntrainement(moteur: string | null, installer: boolean): Promise<string | null> {
  const py = await pythonSysteme();
  const [maj, min] = minimumPython(moteur);
  if (py && (py.version[0] > maj || (py.version[0] === maj && py.version[1] >= min))) return py.chemin;
  const prive = pythonPrive();
  if (prive || !installer) return prive;
  return assurerPythonPrive();
}

async function pythonSysteme(): Promise<{ chemin: string; version: [number, number] } | null> {
  const candidats =
    process.platform === "win32"
      ? ["py", "python"]
      : ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3", "python3"];
  for (const c of candidats) {
    try {
      const args = c === "py" ? ["-3", "--version"] : ["--version"];
      const { stdout, stderr } = await exec(c, args, { timeout: 10_000 });
      const m = /Python (\d+)\.(\d+)/.exec(`${stdout}${stderr}`);
      if (m) return { chemin: c, version: [Number(m[1]), Number(m[2])] };
    } catch {
      /* suivant */
    }
  }
  return null;
}

export async function etat(qui: string): Promise<EtatEntrainement> {
  const hw = detectHardware();
  const cap = capaciteDe(hw, await versionMac());
  const tem = lireTemoin();
  const b = cap.base;
  const obstacles: string[] = [];
  const venvLa = existsSync(pythonVenv());
  /*
   * Sans Python assez récent sur la machine, OxoAI pose le sien (Python 3.12,
   * pythonPrive.ts, décidé par Medhi le 27/09/2026) : un obstacle seulement là
   * où il ne sait pas le faire.
   */
  if (cap.possible && !venvLa && !(await pythonPourEntrainement(cap.moteur, false)) && pythonPriveInstallable() !== null) {
    const py = await pythonSysteme();
    const minimum = minimumPython(cap.moteur);
    if (!py) obstacles.push(t("Python 3 est absent de cette machine. Installez-le (site officiel python.org, ou Homebrew), puis revenez ici."));
    else obstacles.push(tf("Python {0}.{1} est trop ancien : il faut Python {2}.{3} ou plus récent (site officiel python.org, ou Homebrew).", py.version[0], py.version[1], minimum[0], minimum[1]));
  }
  const pret = Boolean(cap.possible && b && tem && tem.moteur === cap.moteur && tem.base === b.cle && venvLa && basePresente(b));
  const reste = b ? b.fichiers.filter((f) => !fichierPresent(b, f)).reduce((s, f) => s + f.taille, 0) : 0;
  const env = cap.moteur ? (venvLa ? 0 : TAILLE_ENVIRONNEMENT[cap.moteur]) : 0;
  const tr: EtatEntrainement["travail"] = !travail
    ? null
    : travail.pour === qui
      ? travail
      : { type: travail.type, autre: true, message: t("Un collègue utilise l'entraînement sur cette machine.") };
  return {
    possible: cap.possible,
    raison: cap.raison,
    moteur: cap.moteur,
    verifie: cap.verifie,
    base: b ? { cle: b.cle, nom: b.nom, depot: b.depot, licence: "Apache 2.0", verifie: b.verifie } : null,
    pret,
    telechargementGo: go(reste + (cap.moteur === "mlx" && !venvLa ? 60e6 : cap.moteur === "nvidia" && !venvLa ? 3e9 : 0)),
    placeGo: go(reste + env),
    placeActuelleGo: go(tailleDossier(racineMoteur())),
    obstacles,
    erreurInstallation,
    travail: tr,
    projets: listerProjets(qui).map(resumer),
  };
}

const fichierPresent = (b: ModeleBase, f: FichierBase) => {
  try {
    return statSync(join(dossierBase(b), f.chemin)).size === f.taille;
  } catch {
    return false;
  }
};
const basePresente = (b: ModeleBase) => b.fichiers.every((f) => fichierPresent(b, f));

/* ------------------------------------------------------------------ */
/* Installation du moteur                                              */
/* ------------------------------------------------------------------ */

/** Fichier de paquets figés, avec leurs empreintes, pour `pip --require-hashes`. */
function exigencesMac(): string {
  return (empreintesPaquets.mac as { paquet: string; empreintes: string[] }[])
    .map((p) => `${p.paquet} ${p.empreintes.map((e) => `--hash=sha256:${e}`).join(" ")}`)
    .join("\n") + "\n";
}

export function installer(qui: string): Promise<void> {
  const tr = occuper({ type: "installation", pour: qui, message: t("Vérification de la machine...") });
  erreurInstallation = null;
  const promesse = (async () => {
    const hw = detectHardware();
    const cap = capaciteDe(hw, await versionMac());
    if (!cap.possible || !cap.moteur || !cap.base) throw new Error(cap.raison);
    const b = cap.base;
    mkdirSync(racineMoteur(), { recursive: true, mode: 0o700 });
    rmSync(temoin(), { force: true });

    /* ----- environnement Python isolé ----- */
    if (!existsSync(pythonVenv())) {
      tr.message = t("Installation de Python...");
      const chemin = await pythonPourEntrainement(cap.moteur, true);
      if (!chemin) throw new Error(t("Python 3 est absent de cette machine. Installez-le (site officiel python.org, ou Homebrew), puis revenez ici."));
      tr.message = t("Création de l'environnement Python isolé...");
      await lancer(chemin, [...(chemin === "py" ? ["-3"] : []), "-m", "venv", dossierPython()], { env: environnement(false), delai: 5 * 60_000 });
    }
    tr.message = cap.moteur === "mlx" ? t("Installation de MLX (moteur d'entraînement d'Apple)...") : t("Installation de PyTorch et des bibliothèques d'entraînement...");
    let lignes = 0;
    const suivrePip = (l: string) => {
      if (!/^(Collecting|Downloading|Installing|Successfully)/.test(l)) return;
      lignes += 1;
      tr.fait = lignes;
      tr.total = Math.max(lignes + 1, cap.moteur === "mlx" ? 40 : 60);
    };
    if (cap.moteur === "mlx") {
      const exigences = join(racineMoteur(), "exigences.txt");
      writeFileSync(exigences, exigencesMac(), { mode: 0o600 });
      await lancer(pythonVenv(), ["-m", "pip", "install", "--require-hashes", "--only-binary=:all:", "--no-deps", "-r", exigences], {
        env: environnement(false),
        delai: 30 * 60_000,
        onLigne: suivrePip,
      });
    } else {
      await lancer(pythonVenv(), ["-m", "pip", "install", "--extra-index-url", INDEX_TORCH_CUDA, ...PAQUETS_NVIDIA], {
        env: environnement(false),
        delai: 60 * 60_000,
        onLigne: suivrePip,
      });
      // Unsloth : ses deux roues vérifiées par empreinte, puis installées depuis le disque. Un échec n'arrête rien.
      try {
        tr.message = t("Installation d'Unsloth (accélère l'entraînement sur carte NVIDIA)...");
        const roues: string[] = [];
        for (const u of UNSLOTH) {
          const chemin = join(racineMoteur(), u.fichier);
          await telecharger(u.url, chemin, u.sha256, u.taille, (fait) => {
            tr.fait = fait;
            tr.total = u.taille;
          });
          roues.push(chemin);
        }
        await lancer(pythonVenv(), ["-m", "pip", "install", "--extra-index-url", INDEX_TORCH_CUDA, ...PAQUETS_NVIDIA, ...roues], {
          env: environnement(false),
          delai: 60 * 60_000,
          onLigne: suivrePip,
        });
        for (const chemin of roues) rmSync(chemin, { force: true });
      } catch (err) {
        console.error("[entrainement] Unsloth non installé, repli sur transformers et peft :", err instanceof Error ? err.message : err);
      }
      // Convertisseur GGUF : sources de llama.cpp à une version précise.
      if (!existsSync(join(dossierLlamaCpp(), "convert_hf_to_gguf.py"))) {
        tr.message = t("Téléchargement du convertisseur GGUF (llama.cpp)...");
        const archive = join(racineMoteur(), "llama.cpp.tar.gz");
        await telecharger(LLAMACPP.archive, archive, LLAMACPP.sha256, LLAMACPP.taille, (fait) => {
          tr.fait = fait;
          tr.total = LLAMACPP.taille;
        });
        mkdirSync(join(racineMoteur(), "llama.cpp"), { recursive: true });
        await exec(tarDuSysteme(), ["-xzf", archive, "-C", join(racineMoteur(), "llama.cpp")], { timeout: 5 * 60_000 });
        rmSync(archive, { force: true });
      }
    }

    /* ----- modèle de base, fichier par fichier, reprise et empreinte ----- */
    mkdirSync(dossierBase(b), { recursive: true, mode: 0o700 });
    const aFaire = b.fichiers.filter((f) => !fichierPresent(b, f));
    const total = aFaire.reduce((s, f) => s + f.taille, 0);
    let precedents = 0;
    tr.message = tf("Téléchargement de {0} ({1} Go)...", b.nom, go(total));
    for (const f of aFaire) {
      await telecharger(`https://huggingface.co/${b.depot}/resolve/${b.revision}/${f.chemin}`, join(dossierBase(b), f.chemin), f.sha256, f.taille, (fait) => {
        tr.fait = precedents + fait;
        tr.total = total;
      });
      precedents += f.taille;
    }

    /* ----- essai ----- */
    tr.message = t("Vérification de l'installation...");
    let versions: Record<string, string> = {};
    if (cap.moteur === "mlx") {
      versions = lireMarqueur<Record<string, string>>(await lancer(pythonVenv(), ["-I", "-c", SCRIPT_MLX_ESSAI], { delai: 5 * 60_000 }));
    } else {
      const sortie = await lancer(pythonVenv(), ["-I", "-c", "import json,torch,peft,bitsandbytes;print('@@OXOAI@@'+json.dumps({'torch':torch.__version__,'cuda':str(torch.cuda.is_available())}))"], { delai: 5 * 60_000 });
      versions = lireMarqueur<Record<string, string>>(sortie);
      if (versions.cuda !== "True") throw new Error(t("PyTorch est installé mais ne voit pas la carte NVIDIA. Mettez à jour le pilote NVIDIA, puis réessayez."));
    }
    writeFileSync(temoin(), JSON.stringify({ moteur: cap.moteur, base: b.cle, date: new Date().toISOString(), versions } satisfies Temoin), { mode: 0o600 });
    journaliser("entrainement.installe", qui, { moteur: cap.moteur, base: b.cle, secondes: Math.round((Date.now() - tr.debut) / 1000) });
  })()
    .catch((err: unknown) => {
      erreurInstallation = expliquer(err);
      throw err;
    })
    .finally(liberer);
  return promesse;
}

/**
 * Retire le moteur : environnement Python, modèles de base, convertisseur. Les
 * projets et les modèles déjà rangés dans LM Studio restent (on les retire
 * chacun depuis son projet).
 */
export function desinstaller(qui: string): void {
  if (travail) throw new ErreurEntrainement(409, t("Un travail d'entraînement occupe la machine : attendez qu'il se termine."));
  const avant = tailleDossier(racineMoteur());
  rmSync(racineMoteur(), { recursive: true, force: true });
  erreurInstallation = null;
  journaliser("entrainement.desinstalle", qui, { liberesGo: go(avant) });
}

/* ------------------------------------------------------------------ */
/* Projets                                                             */
/* ------------------------------------------------------------------ */

export interface Exemple {
  question: string;
  reponse: string;
}

export interface Ligne {
  question: string;
  attendu: string;
  base: string;
  entraine: string;
}

export interface Projet {
  id: string;
  pour: string;
  nom: string;
  cree: string;
  modifie: string;
  exemples: Exemple[];
  /** Paires tirées d'un document par le modèle du Chat, en attente de relecture. */
  propositions: Exemple[];
  entrainement: {
    etat: "fini" | "arrete" | "echec";
    date: string;
    base: CleBase;
    moteur: IdMoteur;
    pas: number;
    secondes: number;
    perte?: number;
    perteValidation?: number;
    exemplesAppris: number;
    misDeCote: number;
    message?: string;
    /** Dernière tentative arrêtée ou ratée, quand un entraînement réussi reste en place. */
    tentative?: { etat: "arrete" | "echec"; date: string; message: string };
  } | null;
  comparaison: { date: string; lignes: Ligne[] } | null;
  /** Le modèle rangé dans LM Studio, s'il l'a été. */
  publie: { dossier: string; cle: string | null; nom: string; date: string; octets: number } | null;
}

export interface ResumeProjet {
  id: string;
  nom: string;
  modifie: string;
  exemples: number;
  propositions: number;
  entraine: boolean;
  publie: string | null;
}

const resumer = (p: Projet): ResumeProjet => ({
  id: p.id,
  nom: p.nom,
  modifie: p.modifie,
  exemples: p.exemples.length,
  propositions: p.propositions.length,
  entraine: p.entrainement?.etat === "fini",
  publie: p.publie?.cle ?? (p.publie ? p.publie.nom : null),
});

const ID = /^[0-9a-f]{24}$/;
const fichierProjet = (id: string) => join(dossierProjet(id), "projet.hlx");
const place = (id: string) => `entrainement:${id}:projet`;

/** Un projet illisible lève une erreur : on n'écrit jamais par-dessus ce qu'on n'a pas pu lire. */
function lireProjet(id: string): Projet | null {
  if (!ID.test(id)) return null;
  const chemin = fichierProjet(id);
  if (!existsSync(chemin)) return null;
  return JSON.parse(dechiffrerOctets(readFileSync(chemin), place(id)).toString("utf8")) as Projet;
}

function ecrireProjet(p: Projet): void {
  p.modifie = new Date().toISOString();
  mkdirSync(dossierProjet(p.id), { recursive: true, mode: 0o700 });
  const tmp = `${fichierProjet(p.id)}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, chiffrerOctets(Buffer.from(JSON.stringify(p), "utf8"), place(p.id)), { mode: 0o600 });
  renameSync(tmp, fichierProjet(p.id));
}

function listerProjets(qui: string): Projet[] {
  let ids: string[] = [];
  try {
    ids = readdirSync(dossierProjets()).filter((n) => ID.test(n));
  } catch {
    return [];
  }
  const projets: Projet[] = [];
  for (const id of ids) {
    try {
      const p = lireProjet(id);
      if (p && p.pour === qui) projets.push(p);
    } catch {
      /* illisible : ni montré ni réécrit */
    }
  }
  return projets.sort((a, b) => b.modifie.localeCompare(a.modifie));
}

/** Le projet de cette personne, ou une erreur 404 (jamais celui d'un autre). */
function projetDe(id: unknown, qui: string): Projet {
  let p: Projet | null = null;
  try {
    p = typeof id === "string" ? lireProjet(id) : null;
  } catch {
    throw new ErreurEntrainement(500, t("Ce projet est illisible sur le disque : il n'a pas été modifié."));
  }
  if (!p || p.pour !== qui) throw new ErreurEntrainement(404, t("Projet introuvable."));
  return p;
}

/* Bornes : un projet reste un fichier qu'on lit d'un coup. */
const EXEMPLES_MAX = 2000;
const QUESTION_MAX = 2000;
const REPONSE_MAX = 6000;
const NOM_MAX = 60;

function propre(texte: unknown, max: number): string {
  return typeof texte === "string" ? texte.replace(/\r\n?/g, "\n").trim().slice(0, max) : "";
}

function nettoyer(liste: unknown): Exemple[] {
  if (!Array.isArray(liste)) return [];
  const vus = new Set<string>();
  const sortie: Exemple[] = [];
  for (const brut of liste) {
    const e = brut as { question?: unknown; reponse?: unknown };
    const question = propre(e?.question, QUESTION_MAX);
    const reponse = propre(e?.reponse, REPONSE_MAX);
    if (!question || !reponse) continue;
    const cle = `${question}\u0000${reponse}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    sortie.push({ question, reponse });
    if (sortie.length >= EXEMPLES_MAX) break;
  }
  return sortie;
}

export function creerProjet(qui: string, nom: unknown): Projet {
  const n = propre(nom, NOM_MAX).replace(/\n/g, " ");
  if (!n) throw new ErreurEntrainement(400, t("Donnez un nom au modèle, par exemple le nom de votre société."));
  const maintenant = new Date().toISOString();
  const p: Projet = { id: randomBytes(12).toString("hex"), pour: qui, nom: n, cree: maintenant, modifie: maintenant, exemples: [], propositions: [], entrainement: null, comparaison: null, publie: null };
  ecrireProjet(p);
  journaliser("entrainement.projet_cree", qui, { projet: p.id });
  return p;
}

export function lire(qui: string, id: unknown): Projet {
  return projetDe(id, qui);
}

/** Remplace les exemples (l'écran envoie la liste entière, après modification). */
export function enregistrerExemples(qui: string, id: unknown, exemples: unknown, propositions?: unknown): Projet {
  const p = projetDe(id, qui);
  if (travail?.projet === p.id) throw new ErreurEntrainement(409, t("Ce projet est en cours de traitement : attendez la fin pour le modifier."));
  p.exemples = nettoyer(exemples);
  if (propositions !== undefined) p.propositions = nettoyer(propositions);
  ecrireProjet(p);
  return p;
}

export function renommer(qui: string, id: unknown, nom: unknown): Projet {
  const p = projetDe(id, qui);
  const n = propre(nom, NOM_MAX).replace(/\n/g, " ");
  if (!n) throw new ErreurEntrainement(400, t("Donnez un nom au modèle, par exemple le nom de votre société."));
  p.nom = n;
  ecrireProjet(p);
  return p;
}

/* ----- lecture de fichiers d'exemples ----- */

/** Une ligne de CSV, guillemets compris (RFC 4180). */
function decouperCsv(texte: string, separateur: string): string[][] {
  const lignes: string[][] = [];
  let champ = "";
  let ligne: string[] = [];
  let guillemets = false;
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i]!;
    if (guillemets) {
      if (c === '"' && texte[i + 1] === '"') {
        champ += '"';
        i++;
      } else if (c === '"') guillemets = false;
      else champ += c;
    } else if (c === '"') guillemets = true;
    else if (c === separateur) {
      ligne.push(champ);
      champ = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && texte[i + 1] === "\n") i++;
      ligne.push(champ);
      lignes.push(ligne);
      ligne = [];
      champ = "";
    } else champ += c;
  }
  if (champ || ligne.length) {
    ligne.push(champ);
    lignes.push(ligne);
  }
  return lignes.filter((l) => l.some((x) => x.trim()));
}

const sansAccent = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const COLONNES_QUESTION = ["question", "questions", "prompt", "input", "instruction", "demande", "q"];
const COLONNES_REPONSE = ["reponse", "reponses", "answer", "completion", "output", "response", "r"];

/**
 * Lit des exemples depuis un fichier CSV (séparateur deviné : point-virgule,
 * virgule ou tabulation ; en-tête facultatif) ou JSONL (une paire par ligne :
 * `question`/`reponse`, `prompt`/`completion`, `input`/`output`, ou une
 * conversation `messages`). Ce qui n'est pas compris est compté, pas inventé.
 */
export function lireFichierExemples(contenu: unknown, nomFichier: unknown): { exemples: Exemple[]; ignorees: number } {
  const texte = typeof contenu === "string" ? contenu.replace(/^﻿/, "").slice(0, 20 * 1024 * 1024) : "";
  if (!texte.trim()) throw new ErreurEntrainement(400, t("Le fichier est vide."));
  const nom = typeof nomFichier === "string" ? nomFichier.toLowerCase() : "";
  const bruts: { question?: unknown; reponse?: unknown }[] = [];
  let ignorees = 0;
  const pareilJsonl = nom.endsWith(".jsonl") || nom.endsWith(".json") || texte.trimStart().startsWith("{") || texte.trimStart().startsWith("[");
  if (pareilJsonl) {
    let objets: unknown[] = [];
    const debut = texte.trimStart();
    if (debut.startsWith("[")) {
      try {
        objets = JSON.parse(debut) as unknown[];
      } catch {
        throw new ErreurEntrainement(400, t("Fichier JSON illisible."));
      }
    } else {
      for (const l of texte.split("\n")) {
        if (!l.trim()) continue;
        try {
          objets.push(JSON.parse(l));
        } catch {
          ignorees++;
        }
      }
    }
    for (const o of objets) {
      const x = (o ?? {}) as Record<string, unknown>;
      const cles = Object.fromEntries(Object.entries(x).map(([k, v]) => [sansAccent(k), v]));
      if (Array.isArray(x.messages)) {
        const msgs = x.messages as { role?: string; content?: unknown }[];
        const q = [...msgs].reverse().find((m) => m.role === "user");
        const r = [...msgs].reverse().find((m) => m.role === "assistant");
        bruts.push({ question: q?.content, reponse: r?.content });
        continue;
      }
      const q = COLONNES_QUESTION.map((c) => cles[c]).find((v) => typeof v === "string");
      const r = COLONNES_REPONSE.map((c) => cles[c]).find((v) => typeof v === "string");
      bruts.push({ question: q, reponse: r });
    }
  } else {
    const premiere = texte.split("\n")[0] ?? "";
    const separateur = [";", "\t", ","].map((s) => [s, premiere.split(s).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
    const lignes = decouperCsv(texte, separateur);
    let iq = 0;
    let ir = 1;
    const entete = (lignes[0] ?? []).map(sansAccent);
    const eq = entete.findIndex((c) => COLONNES_QUESTION.includes(c));
    const er = entete.findIndex((c) => COLONNES_REPONSE.includes(c));
    if (eq >= 0 && er >= 0) {
      iq = eq;
      ir = er;
      lignes.shift();
    }
    for (const l of lignes) bruts.push({ question: l[iq], reponse: l[ir] });
  }
  const exemples = nettoyer(bruts);
  ignorees += bruts.length - exemples.length;
  if (exemples.length === 0) {
    throw new ErreurEntrainement(400, t("Aucune paire question et réponse trouvée. Attendu : un CSV à deux colonnes (question ; réponse) ou un JSONL avec « question » et « reponse »."));
  }
  return { exemples, ignorees };
}

export function importer(qui: string, id: unknown, contenu: unknown, nomFichier: unknown): { projet: Projet; ajoutes: number; ignorees: number } {
  const p = projetDe(id, qui);
  const lu = lireFichierExemples(contenu, nomFichier);
  const avant = p.exemples.length;
  p.exemples = nettoyer([...p.exemples, ...lu.exemples]);
  ecrireProjet(p);
  return { projet: p, ajoutes: p.exemples.length - avant, ignorees: lu.ignorees };
}

/* ----- paires tirées d'un document ----- */

const MORCEAU = 3000;
const MORCEAUX_MAX = 40;

/**
 * Coupe un document en morceaux d'environ 3 000 caractères, aux fins de
 * paragraphe quand c'est possible : un fait coupé en deux ne donne pas de
 * bonne question.
 */
function morceaux(texte: string): string[] {
  const sortie: string[] = [];
  let reste = texte.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  while (reste && sortie.length < MORCEAUX_MAX) {
    if (reste.length <= MORCEAU) {
      sortie.push(reste);
      break;
    }
    let coupe = reste.lastIndexOf("\n\n", MORCEAU);
    if (coupe < MORCEAU / 2) coupe = reste.lastIndexOf(". ", MORCEAU) + 1;
    if (coupe < MORCEAU / 2) coupe = MORCEAU;
    sortie.push(reste.slice(0, coupe).trim());
    reste = reste.slice(coupe).trim();
  }
  return sortie.filter((m) => m.length >= 80);
}

/** Les paires rendues par le modèle, tolérant du texte autour du JSON. */
function lirePaires(texte: string): Exemple[] {
  const debut = texte.indexOf("[");
  const fin = texte.lastIndexOf("]");
  if (debut < 0 || fin <= debut) return [];
  try {
    const liste = JSON.parse(texte.slice(debut, fin + 1)) as { question?: unknown; reponse?: unknown; réponse?: unknown }[];
    return nettoyer(liste.map((x) => ({ question: x?.question, reponse: x?.reponse ?? x?.réponse })));
  } catch {
    return [];
  }
}

/*
 * « Couvre chacun des faits » : essayé le 25/09/2026 avec Qwen3 8B sur un
 * règlement de cinq faits, l'ancienne consigne (« de 3 à 8 paires ») n'en
 * rendait que deux, tirées du premier paragraphe.
 */
const CONSIGNE_PAIRES =
  "Tu prépares des exemples pour apprendre à un assistant les faits d'un document d'entreprise. " +
  "À partir de l'extrait fourni, écris des paires question et réponse, en français, que poserait un salarié ou un client. " +
  "Couvre chacun des faits de l'extrait (chiffres, dates, horaires, prix, règles), pas seulement le premier : au moins une paire par fait, 12 au plus. " +
  "Chaque réponse est une ou deux phrases complètes, tirées uniquement de l'extrait : n'invente rien, ne cite pas « le document ». " +
  "Si l'extrait ne contient aucun fait utile, rends une liste vide. " +
  'Rends seulement du JSON, sous la forme [{"question": "...", "reponse": "..."}].';

/**
 * Un modèle de conversation local chargé, pour lire le document.
 *
 * `completer` prend un modèle chargé s'il y en a un, sinon le premier modèle
 * local venu, sans le charger. Or LM Studio, sur ce poste, ne charge rien à
 * la demande : vu le 25/09/2026, « No models loaded » (400) juste après un
 * entraînement, qui avait déchargé Qwen3 8B. On charge donc le plus gros
 * modèle de conversation local qui ne soit ni un modèle d'écran ni un modèle
 * entraîné ici (trop petit pour bien lire un document).
 */
async function modeleDeLecture(): Promise<void> {
  const locaux = (await models(true)).filter(
    (m) => m.backendKind === "lmstudio" && m.roles.includes("chat") && !m.roles.includes("gui") && !m.roles.includes("vision") && !m.entraine,
  );
  if (locaux.length === 0 || locaux.some((m) => m.loaded)) return;
  const plusGros = [...locaux].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0]!;
  await loadModel(plusGros.id);
}

/**
 * Demande au modèle du Chat (local d'abord, completion.ts) de tirer des paires
 * d'un document. Rien n'entre dans les exemples sans relecture : les paires
 * vont dans `propositions`, que l'écran montre pour accepter, corriger ou
 * écarter.
 */
export function generer(qui: string, id: unknown, texte: unknown, source: unknown): Travail {
  const p = projetDe(id, qui);
  const doc = typeof texte === "string" ? texte.slice(0, 400_000) : "";
  const parts = morceaux(doc);
  if (parts.length === 0) throw new ErreurEntrainement(400, t("Le document ne contient pas assez de texte pour en tirer des exemples."));
  const tr = occuper({ type: "generation", pour: qui, projet: p.id, message: t("Lecture du document par le modèle du Chat..."), total: parts.length });
  const nomSource = propre(source, 200);
  void (async () => {
    let ajoutes = 0;
    let echecs = 0;
    let derniereErreur = "";
    tr.message = t("Chargement du modèle du Chat...");
    await modeleDeLecture().catch(() => undefined);
    for (const [i, extrait] of parts.entries()) {
      if (arretDemande) break;
      tr.message = tf("Lecture du document : partie {0} sur {1}", i + 1, parts.length);
      const r = await completer(
        [
          { role: "system", content: CONSIGNE_PAIRES },
          { role: "user", content: `${nomSource ? `Document : ${nomSource}\n\n` : ""}Extrait :\n${extrait}` },
        ],
        { qui, maxTokens: 1800, delaiMs: 5 * 60_000 },
      );
      tr.fait = i + 1;
      if (!r.ok) {
        echecs++;
        derniereErreur = r.message;
        console.error("[entrainement] lecture d'un document :", r.message);
        continue;
      }
      const paires = lirePaires(r.texte);
      if (paires.length === 0) continue;
      // Relu depuis le disque à chaque fois : l'écran a pu corriger les exemples entre-temps.
      const frais = lireProjet(p.id);
      if (!frais) break;
      const avant = frais.propositions.length;
      frais.propositions = nettoyer([...frais.propositions, ...paires]);
      ajoutes += frais.propositions.length - avant;
      ecrireProjet(frais);
    }
    journaliser("entrainement.paires_generees", qui, { projet: p.id, morceaux: parts.length, paires: ajoutes, echecs });
    // Le bilan reste affiché un instant : l'écran le lit avant que le travail ne disparaisse.
    tr.message =
      ajoutes > 0
        ? tf("{0} proposition(s) tirée(s) du document : relisez-les ci-dessous.", ajoutes)
        : echecs > 0
          ? tf("Le modèle du Chat n'a pas pu lire le document : {0}", derniereErreur)
          : t("Aucun fait utile n'a été trouvé dans ce document.");
    await new Promise((r) => setTimeout(r, 4000));
  })()
    .catch((err: unknown) => console.error("[entrainement] génération :", err instanceof Error ? err.message : err))
    .finally(liberer);
  return tr;
}

/* ------------------------------------------------------------------ */
/* Entraînement                                                        */
/* ------------------------------------------------------------------ */

/**
 * Exemples d'ancrage : des questions ordinaires, répondues par le modèle de
 * base lui-même, mêlées aux exemples de la personne.
 *
 * Mesuré le 25/09/2026 (Qwen3 1.7B, 30 exemples sur une société imaginaire,
 * 150 pas) : sans eux, le modèle a bien appris les faits (12 réponses justes
 * sur 15 questions jamais vues), mais il a perdu le reste. « La capitale de
 * l'Italie est Verona », « 12 fois 11 » répondu par une suite de « 142 ». Un
 * modèle qui ne sait plus que ce qu'on lui a appris ne sert à rien dans un
 * Chat. Rappeler au modèle, pendant l'entraînement, ce qu'il répondait avant
 * est la parade classique (auto-distillation) ; l'effet mesuré est sous
 * `reglages`.
 *
 * Générées une fois par modèle de base, puis gardées à côté de lui.
 */
const QUESTIONS_ANCRAGE = [
  "Quelle est la capitale de l'Italie ?", "Combien font 7 fois 8 ?", "Écris un court mail pour décaler une réunion à jeudi.",
  "Explique ce qu'est une facture d'acompte.", "Donne trois conseils pour bien dormir.", "Traduis en anglais : « Merci pour votre retour rapide. »",
  "Qu'est-ce que la TVA ?", "Résume en une phrase l'intérêt d'une sauvegarde informatique.", "Quelle est la différence entre un devis et une facture ?",
  "Combien y a-t-il de jours dans une année bissextile ?", "Propose un titre pour une présentation sur la sécurité au travail.",
  "Qui a écrit Les Misérables ?", "Convertis 3 kilomètres en mètres.", "Écris une phrase pour souhaiter bon anniversaire à un collègue.",
  "Qu'est-ce qu'un tableur ?", "Donne un synonyme de « rapide ».", "Comment calcule-t-on un pourcentage d'augmentation ?",
  "Quelle est la planète la plus proche du Soleil ?", "Rédige une phrase d'accueil pour un nouveau client.", "Qu'est-ce que la photosynthèse, en une phrase ?",
  "What is the capital of Spain?", "Explique simplement ce qu'est un mot de passe fort.", "Cite trois fruits riches en vitamine C.",
  "Qu'est-ce qu'un bon de commande ?", "Combien font 15 % de 200 ?", "Écris une liste de courses pour un pique-nique.",
  "Quel est le rôle d'un comptable ?", "Comment dit-on « bonjour » en espagnol ?", "Donne une définition courte du mot « inventaire ».",
  "Quelle est la différence entre un e-mail et un SMS ?",
];

/**
 * Réglages de l'entraînement, choisis en mesurant.
 *
 * - LoRA de rang 16 sur les 16 dernières couches, taux d'apprentissage 1e-4,
 *   échelle 10 (la moitié du défaut de mlx-lm).
 * - Mesuré le 25/09/2026, Qwen3 1.7B, M4 16 Go, 30 exemples sur une société
 *   imaginaire (15 faits, deux formulations chacun) plus les 30 d'ancrage,
 *   120 pas, 2 min 10 s, 6,3 Go au plus fort ; questions de contrôle posées
 *   dans une troisième formulation, jamais vue :
 *
 *   | Réglage                            | Faits justes | Questions ordinaires (5, hors ancrage) |
 *   |------------------------------------|--------------|----------------------------------------|
 *   | modèle de départ                   | 0 sur 15     | 4 justes (Joconde fausse)              |
 *   | échelle 20, 150 pas, sans ancrage  | 12 sur 15    | 1 juste, deux réponses en boucle       |
 *   | échelle 20, 120 pas, avec ancrage  | 14 sur 15    | 2 justes (Tokyo devient « Roma »)      |
 *   | **échelle 10, 120 pas, ancrage**   | **15 sur 15**| 3 justes (Tokyo devient « Nagasaki »)  |
 *
 *   Reste une fuite : « Qui a peint la Joconde ? » reçoit « Odile Kerbrat »,
 *   la fondatrice imaginaire (le modèle de départ se trompait déjà, autrement).
 *   Un petit modèle entraîné sur une trentaine de faits en garde des traces
 *   ailleurs : l'écran le dit, et la comparaison sert à le voir.
 * - Le nombre de passes décroît avec le nombre d'exemples : un petit jeu doit
 *   être vu plusieurs fois pour être retenu, un grand déborde vite.
 * - La perte ne porte que sur les réponses (`mask_prompt`) : on n'apprend pas
 *   au modèle à poser les questions.
 */
function reglages(nPersonne: number, nAncrage: number): { lot: number; pas: number; taux: number; rang: number; echelle: number; couches: number; longueur: number } {
  const lot = 4;
  /*
   * Le nombre de passes se décide sur les exemples de la personne seuls :
   * compté ancrage compris, un jeu de 32 exemples tombait à 5 passes au lieu
   * de 8, alors que les 30 exemples d'ancrage ne sont pas à apprendre.
   * (Mesuré le 25/09/2026 sur ce jeu : erreur sur les exemples mis de côté
   * de 0,98 à 5 passes, 0,94 à 8 ; elle est haute parce que l'un des quatre
   * exemples mis de côté porte un fait qui n'a qu'une seule formulation,
   * donc jamais vu. Le modèle ne peut pas deviner ce qu'on ne lui a pas montré.)
   */
  const passes = nPersonne <= 60 ? 8 : nPersonne <= 300 ? 5 : 3;
  const pas = Math.min(2000, Math.max(60, Math.round(((nPersonne + nAncrage) * passes) / lot)));
  return { lot, pas, taux: 1e-4, rang: 16, echelle: 10, couches: 16, longueur: 1024 };
}

/**
 * Les exemples mis de côté : jamais montrés pendant l'entraînement, ils
 * servent à mesurer ce que le modèle a retenu (perte de validation) et à la
 * comparaison avant et après. Un sur dix, quatre au moins et cinq au plus,
 * choisis à intervalles réguliers pour ne pas dépendre de l'ordre du fichier.
 * Quatre au moins : mlx-lm refuse une validation plus petite que son lot
 * (« Dataset must have at least batch_size=4 examples », vu le 25/09/2026
 * avec trois exemples mis de côté sur trente).
 */
function partager(exemples: Exemple[]): { appris: Exemple[]; deCote: Exemple[] } {
  if (exemples.length < 20) return { appris: exemples, deCote: [] };
  const n = Math.min(5, Math.max(4, Math.floor(exemples.length / 10)));
  const pas = Math.floor(exemples.length / n);
  const indices = new Set(Array.from({ length: n }, (_, i) => i * pas + Math.floor(pas / 2)));
  return {
    appris: exemples.filter((_, i) => !indices.has(i)),
    deCote: exemples.filter((_, i) => indices.has(i)),
  };
}

const conversation = (e: Exemple) =>
  JSON.stringify({ messages: [{ role: "user", content: e.question }, { role: "assistant", content: e.reponse }] });

export const EXEMPLES_MIN = 10;

/** Durée estimée, en secondes : pas par seconde mesurés, corrigés de la longueur des exemples. */
function estimation(b: ModeleBase, exemples: Exemple[]): { secondes: number; disqueGo: number } {
  const r = reglages(exemples.length, QUESTIONS_ANCRAGE.length);
  const moyenne = exemples.reduce((s, e) => s + e.question.length + e.reponse.length, 0) / Math.max(1, exemples.length);
  // Les exemples mesurés (ancrage compris) faisaient environ 250 caractères, question et réponse comprises.
  const longueur = Math.max(1, moyenne / 250);
  return {
    secondes: Math.round(r.pas / b.pasParSeconde * longueur + 40),
    // Modèle fondu en 8 bits : la moitié des poids en 16 bits (mesuré : 1,7 Go pour 4,1 Go).
    disqueGo: go(b.poids * 0.5 + 0.2e9),
  };
}

export function estimer(qui: string, id: unknown): { secondes: number; disqueGo: number; pas: number; misDeCote: number } | null {
  const p = projetDe(id, qui);
  const hw = detectHardware();
  const tem = lireTemoin();
  const b = tem ? base(tem.base) : capaciteDe(hw, null).base;
  if (!b) return null;
  const { appris, deCote } = partager(p.exemples);
  const e = estimation(b, appris);
  return { ...e, pas: reglages(appris.length, QUESTIONS_ANCRAGE.length).pas, misDeCote: deCote.length };
}

/**
 * Fait la place en mémoire avant de calculer.
 *
 * `libererPourImage` raisonne sur les poids des modèles résidents (plus
 * 30 %). Mesuré le 25/09/2026 : Qwen3 8B, 5 Go de poids, retient 10,4 Go de
 * mémoire graphique avec son contexte de 28 160 jetons ; l'estimation passe
 * donc à côté. Jusqu'à 24 Go de mémoire, on décharge tous les modèles au repos
 * (jamais un modèle qui répond), quoi qu'en dise l'estimation. Puis on
 * vérifie : s'il reste un modèle en train de répondre, on ne lance rien.
 */
async function fairePlace(b: ModeleBase): Promise<void> {
  const petite = totalmem() <= 24 * 1024 ** 3;
  await libererPourImage(petite ? Number.POSITIVE_INFINITY : b.poids * 1.5);
  if (!petite) return;
  const lms = await findLms();
  if (!lms) return;
  try {
    const { stdout } = await exec(lms, ["ps", "--json"], { timeout: 15_000 });
    const charges = JSON.parse(stdout) as { modelKey?: string; type?: string; status?: string }[];
    const occupe = charges.find((e) => e.type !== "embedding" && e.status && e.status !== "idle");
    if (occupe) {
      throw new ErreurEntrainement(
        409,
        tf("Le modèle {0} est en train de répondre dans LM Studio : sur cette machine, il ne laisse pas assez de mémoire pour entraîner. Réessayez quand il aura fini.", occupe.modelKey ?? "?"),
      );
    }
  } catch (err) {
    if (err instanceof ErreurEntrainement) throw err;
    /* état illisible : on tente quand même, l'erreur de mémoire sera dite en clair */
  }
}

/** Les réponses d'un modèle (avec ou sans adaptateur) à des questions. */
async function repondre(b: ModeleBase, moteur: IdMoteur, adaptateur: string, questions: string[], travailDossier: string, jetons: number, suivre?: (n: number) => void): Promise<string[]> {
  const entree = join(travailDossier, `questions-${randomBytes(4).toString("hex")}.json`);
  const sortie = `${entree}.reponses.json`;
  writeFileSync(entree, JSON.stringify(questions), { mode: 0o600 });
  try {
    await lancer(
      pythonVenv(),
      ["-I", "-c", moteur === "mlx" ? SCRIPT_MLX_REPONDRE : SCRIPT_NVIDIA_REPONDRE, dossierBase(b), adaptateur, entree, sortie, String(jetons)],
      {
        cwd: travailDossier,
        delai: 60 * 60_000,
        onLigne: (l) => {
          const m = /^@@REPONSE@@(\d+)/.exec(l);
          if (m) suivre?.(Number(m[1]));
        },
      },
    );
    return JSON.parse(readFileSync(sortie, "utf8")) as string[];
  } finally {
    rmSync(entree, { force: true });
    rmSync(sortie, { force: true });
  }
}

/** Les exemples d'ancrage de ce modèle de base, générés une fois. */
async function ancrage(b: ModeleBase, moteur: IdMoteur, tr: Travail): Promise<Exemple[]> {
  const fichier = join(dossierBase(b), "ancrage.json");
  try {
    const deja = JSON.parse(readFileSync(fichier, "utf8")) as Exemple[];
    if (deja.length === QUESTIONS_ANCRAGE.length) return deja;
  } catch {
    /* pas encore généré */
  }
  tr.message = t("Préparation des exemples d'ancrage (une seule fois pour ce modèle)...");
  tr.total = QUESTIONS_ANCRAGE.length;
  const reponses = await repondre(b, moteur, "", QUESTIONS_ANCRAGE, dossierBase(b), 160, (n) => (tr.fait = n));
  const exemples = QUESTIONS_ANCRAGE.map((question, i) => ({ question, reponse: reponses[i] ?? "" })).filter((e) => e.reponse);
  writeFileSync(fichier, JSON.stringify(exemples), { mode: 0o600 });
  return exemples;
}

/** Fichier de réglages pour `mlx_lm lora -c`. Les chaînes passent par JSON, que YAML lit tel quel. */
function configurationMlx(b: ModeleBase, dossier: string, r: ReturnType<typeof reglages>, validation: boolean): string {
  const lignes: Record<string, string | number | boolean> = {
    model: JSON.stringify(dossierBase(b)),
    train: true,
    data: JSON.stringify(join(dossier, "donnees")),
    adapter_path: JSON.stringify(join(dossier, "adaptateur-nouveau")),
    fine_tune_type: JSON.stringify("lora"),
    mask_prompt: true,
    num_layers: r.couches,
    batch_size: r.lot,
    iters: r.pas,
    learning_rate: r.taux,
    steps_per_report: 5,
    steps_per_eval: validation ? Math.max(10, Math.round(r.pas / 5)) : r.pas + 1,
    val_batches: -1,
    save_every: Math.max(20, Math.round(r.pas / 3)),
    max_seq_length: r.longueur,
    seed: 7,
  };
  return (
    Object.entries(lignes).map(([k, v]) => `${k}: ${v}`).join("\n") +
    `\nlora_parameters:\n  rank: ${r.rang}\n  scale: ${r.echelle}\n  dropout: 0.0\n`
  );
}

export function entrainer(qui: string, id: unknown): Travail {
  const p = projetDe(id, qui);
  const tem = lireTemoin();
  const b = tem ? base(tem.base) : undefined;
  if (!tem || !b || !basePresente(b) || !existsSync(pythonVenv())) {
    throw new ErreurEntrainement(409, t("Le moteur d'entraînement n'est pas encore installé sur cette machine."));
  }
  if (p.exemples.length < EXEMPLES_MIN) {
    throw new ErreurEntrainement(400, tf("Il faut {0} exemples au moins pour entraîner un modèle ({1} pour l'instant).", EXEMPLES_MIN, p.exemples.length));
  }
  const tr = occuper({ type: "entrainement", pour: qui, projet: p.id, message: t("Place faite en mémoire...") });
  const dossier = dossierProjet(p.id);
  const { appris, deCote } = partager(p.exemples);
  void (async () => {
    const debut = Date.now();
    let moteurNvidia = "";
    let fini = false;
    let enCalcul = false;
    try {
      await fairePlace(b);
      const ancres = await ancrage(b, tem.moteur, tr);
      const r = reglages(appris.length, ancres.length);
      enCalcul = true;
      tr.fait = 0;
      tr.total = r.pas;
      tr.message = t("Entraînement en cours...");
      /*
       * Le nouvel adaptateur s'écrit à côté de l'ancien : un entraînement
       * arrêté ou raté ne fait pas perdre le modèle qui marchait (vu le
       * 25/09/2026 : relancer puis arrêter effaçait l'entraînement réussi).
       */
      rmSync(join(dossier, "adaptateur-nouveau"), { recursive: true, force: true });
      rmSync(join(dossier, "donnees"), { recursive: true, force: true });
      mkdirSync(join(dossier, "donnees"), { recursive: true, mode: 0o700 });
      // Mélange déterministe : les exemples d'ancrage répartis parmi ceux de la personne.
      const tous = [...appris, ...ancres].map((e, i) => ({ e, k: (i * 7919) % 104729 })).sort((a, c) => a.k - c.k).map((x) => x.e);
      writeFileSync(join(dossier, "donnees", "train.jsonl"), tous.map(conversation).join("\n") + "\n", { mode: 0o600 });
      const validation = deCote.length >= r.lot;
      if (validation) writeFileSync(join(dossier, "donnees", "valid.jsonl"), deCote.map(conversation).join("\n") + "\n", { mode: 0o600 });

      if (tem.moteur === "mlx") {
        writeFileSync(join(dossier, "reglages.yaml"), configurationMlx(b, dossier, r, validation), { mode: 0o600 });
        await lancer(pythonVenv(), ["-I", "-m", "mlx_lm", "lora", "-c", join(dossier, "reglages.yaml")], {
          cwd: dossier,
          onLigne: (l) => {
            const pasFait = /^Iter (\d+): Train loss ([\d.]+).*?It\/sec ([\d.]+).*?Peak mem ([\d.]+) GB/.exec(l);
            if (pasFait) {
              tr.fait = Number(pasFait[1]);
              tr.perte = Number(pasFait[2]);
              const vitesse = Number(pasFait[3]);
              tr.resteSecondes = vitesse > 0 ? Math.round((r.pas - tr.fait) / vitesse) : undefined;
              tr.memoireGo = Number(pasFait[4]);
              tr.message = tf("Entraînement : pas {0} sur {1}", tr.fait, r.pas);
            }
            const val = /^Iter (\d+): Val loss ([\d.]+)/.exec(l);
            if (val) tr.perteValidation = Number(val[2]);
          },
        });
      } else {
        await lancer(pythonVenv(), ["-I", "-c", SCRIPT_NVIDIA_ENTRAINER, dossierBase(b), join(dossier, "donnees"), join(dossier, "adaptateur-nouveau"), JSON.stringify(r)], {
          cwd: dossier,
          onLigne: (l) => {
            // Le moteur réellement pris : Unsloth, ou transformers et peft en repli (et pourquoi).
            if (l.startsWith("@@MOTEUR@@")) {
              moteurNvidia = l.slice(10);
              console.log("[entrainement] moteur NVIDIA :", moteurNvidia);
              return;
            }
            if (!l.startsWith("@@PAS@@")) return;
            try {
              const x = JSON.parse(l.slice(7)) as { pas: number; total: number; perte?: number; validation?: number };
              tr.fait = x.pas;
              tr.total = x.total;
              if (typeof x.perte === "number") tr.perte = Math.round(x.perte * 1000) / 1000;
              if (typeof x.validation === "number") tr.perteValidation = Math.round(x.validation * 1000) / 1000;
              const ecoule = (Date.now() - debut) / 1000;
              tr.resteSecondes = x.pas > 0 ? Math.round((ecoule / x.pas) * (x.total - x.pas)) : undefined;
              tr.message = tf("Entraînement : pas {0} sur {1}", x.pas, x.total);
            } catch {
              /* ligne tronquée */
            }
          },
        });
      }
      fini = true;
      // Les points d'étape intermédiaires ne servent plus : seul l'adaptateur final reste.
      for (const nom of readdirSync(join(dossier, "adaptateur-nouveau"))) {
        if (/^\d+_adapters\.safetensors$/.test(nom)) rmSync(join(dossier, "adaptateur-nouveau", nom), { force: true });
      }
      rmSync(join(dossier, "adaptateur"), { recursive: true, force: true });
      renameSync(join(dossier, "adaptateur-nouveau"), join(dossier, "adaptateur"));
      const frais = lireProjet(p.id) ?? p;
      frais.entrainement = {
        etat: "fini", date: new Date().toISOString(), base: b.cle, moteur: tem.moteur, pas: r.pas,
        secondes: Math.round((Date.now() - debut) / 1000), perte: tr.perte, perteValidation: tr.perteValidation,
        exemplesAppris: appris.length, misDeCote: deCote.length,
      };
      frais.comparaison = null;
      ecrireProjet(frais);
      journaliser("entrainement.termine", qui, {
        projet: p.id, base: b.cle, pas: r.pas, secondes: frais.entrainement.secondes, exemples: appris.length,
        ...(moteurNvidia ? { unsloth: moteurNvidia === "unsloth" } : {}),
      });
    } catch (err) {
      const message = err instanceof ErreurEntrainement ? err.message : expliquer(err);
      try {
        const frais = lireProjet(p.id) ?? p;
        const tentative = { etat: arretDemande ? ("arrete" as const) : ("echec" as const), date: new Date().toISOString(), message };
        if (frais.entrainement?.etat === "fini" && existsSync(join(dossier, "adaptateur"))) {
          // Le modèle précédent reste utilisable ; on dit seulement que la nouvelle tentative n'a pas abouti.
          frais.entrainement = { ...frais.entrainement, tentative };
        } else {
          frais.entrainement = {
            etat: tentative.etat, date: tentative.date, base: b.cle, moteur: tem.moteur, pas: enCalcul ? tr.fait : 0,
            secondes: Math.round((Date.now() - debut) / 1000), perte: tr.perte, perteValidation: tr.perteValidation,
            exemplesAppris: appris.length, misDeCote: deCote.length, message,
          };
        }
        ecrireProjet(frais);
      } catch {
        /* projet illisible : on ne l'écrase pas */
      }
      if (!fini) rmSync(join(dossier, "adaptateur-nouveau"), { recursive: true, force: true });
      journaliser("entrainement.termine", qui, { projet: p.id, ok: false, arrete: arretDemande });
      console.error("[entrainement]", message);
    } finally {
      // Les exemples en clair ne restent pas sur le disque : le projet chiffré les garde.
      rmSync(join(dossier, "donnees"), { recursive: true, force: true });
    }
  })().finally(liberer);
  return tr;
}

/** Arrête le travail en cours de cette personne (entraînement, comparaison, lecture d'un document). */
export function arreter(qui: string): boolean {
  if (!travail || travail.pour !== qui || travail.type === "installation") return false;
  arretDemande = true;
  const p = processus;
  if (p && p.exitCode === null) {
    arreterArbre(p);
    setTimeout(() => {
      if (p.exitCode === null) arreterArbre(p, "SIGKILL");
    }, 5000).unref();
  }
  return true;
}

/**
 * À la fermeture de la passerelle. Synchrone : à l'arrêt du processus, une
 * promesse n'aurait pas le temps d'aboutir. Un entraînement laissé orphelin
 * garderait plusieurs Go de mémoire graphique.
 */
export function arreterEnPartant(): void {
  arretDemande = true;
  if (processus && processus.exitCode === null) {
    try {
      arreterArbre(processus, "SIGKILL");
    } catch {
      /* déjà parti */
    }
  }
  /*
   * La suite du travail (effacer les exemples en clair, l'adaptateur à moitié
   * appris) ne s'exécutera pas : le processus s'arrête. Vu le 25/09/2026, une
   * passerelle arrêtée en plein calcul laissait `donnees/` sur le disque. On
   * efface donc ici, de façon synchrone.
   */
  if (travail?.projet && ID.test(travail.projet)) {
    for (const reste of ["donnees", "adaptateur-nouveau", "fusion", "sortie"]) {
      try {
        rmSync(join(dossierProjet(travail.projet), reste), { recursive: true, force: true });
      } catch {
        /* rien à faire de plus à l'arrêt */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Comparaison avant et après                                          */
/* ------------------------------------------------------------------ */

const QUESTIONS_LIBRES_MAX = 5;

/**
 * Pose les mêmes questions au modèle de base et au modèle entraîné : les
 * exemples mis de côté (jamais vus pendant l'entraînement), plus celles que la
 * personne ajoute. Les réponses sont montrées côte à côte avec la réponse
 * attendue ; aucune note automatique : juger si « Pontivy » vaut « à
 * Pontivy, dans le Morbihan » est l'affaire de la personne, pas d'une règle.
 */
export function comparer(qui: string, id: unknown, questions: unknown): Travail {
  const p = projetDe(id, qui);
  const tem = lireTemoin();
  const b = tem ? base(tem.base) : undefined;
  const adaptateur = join(dossierProjet(p.id), "adaptateur");
  if (!tem || !b || p.entrainement?.etat !== "fini" || !existsSync(join(adaptateur, "adapters.safetensors")) && !existsSync(join(adaptateur, "adapter_model.safetensors"))) {
    throw new ErreurEntrainement(409, t("Entraînez d'abord le modèle."));
  }
  const { deCote } = partager(p.exemples);
  const libres = (Array.isArray(questions) ? questions : []).map((q) => propre(q, QUESTION_MAX)).filter(Boolean).slice(0, QUESTIONS_LIBRES_MAX);
  const liste: { question: string; attendu: string }[] = [
    ...deCote.map((e) => ({ question: e.question, attendu: e.reponse })),
    ...libres.map((q) => ({ question: q, attendu: "" })),
  ];
  if (liste.length === 0) {
    throw new ErreurEntrainement(400, t("Posez au moins une question pour comparer (avec moins de 20 exemples, aucun n'est mis de côté)."));
  }
  const tr = occuper({ type: "comparaison", pour: qui, projet: p.id, message: t("Place faite en mémoire..."), total: liste.length * 2 });
  void (async () => {
    try {
      await fairePlace(b);
      const qs = liste.map((l) => l.question);
      tr.message = t("Réponses du modèle de départ...");
      const avant = await repondre(b, tem.moteur, "", qs, dossierProjet(p.id), 200, (n) => (tr.fait = n));
      tr.message = t("Réponses du modèle entraîné...");
      const apres = await repondre(b, tem.moteur, adaptateur, qs, dossierProjet(p.id), 200, (n) => (tr.fait = liste.length + n));
      const frais = lireProjet(p.id) ?? p;
      frais.comparaison = {
        date: new Date().toISOString(),
        lignes: liste.map((l, i) => ({ ...l, base: avant[i] ?? "", entraine: apres[i] ?? "" })),
      };
      ecrireProjet(frais);
    } catch (err) {
      tr.message = err instanceof ErreurEntrainement ? err.message : expliquer(err);
      console.error("[entrainement] comparaison :", tr.message);
      // Laissé visible un instant : l'écran lit le message avant que le travail ne disparaisse.
      await new Promise((r) => setTimeout(r, 4000));
    }
  })().finally(liberer);
  return tr;
}

/* ------------------------------------------------------------------ */
/* Ranger le modèle dans LM Studio, l'en retirer                       */
/* ------------------------------------------------------------------ */

/** Nom de dossier sûr : lettres, chiffres, tirets. Il devient le nom affiché par LM Studio. */
function nomDeDossier(b: ModeleBase, nom: string): string {
  const court = sansAccent(nom).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "modele";
  /*
   * Le nom commence par celui du modèle de base, « qwen3-… » : c'est à lui que
   * la passerelle reconnaît un Qwen3 et coupe son raisonnement quand il le
   * faut (chat.ts, completion.ts), et qu'elle lui donne le rôle de
   * conversation (config.ts).
   */
  let dossier = `${b.cle}-${court}`;
  for (let i = 2; existsSync(join(dossierNosModeles(), dossier)); i++) dossier = `${b.cle}-${court}-${i}`;
  return dossier;
}

/** La clé sous laquelle LM Studio a rangé le dossier, relue dans `lms ls`. */
async function cleLmStudio(dossier: string): Promise<string | null> {
  const lms = await findLms();
  if (!lms) return null;
  for (let i = 0; i < 5; i++) {
    try {
      const { stdout } = await exec(lms, ["ls", "--json"], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
      const liste = JSON.parse(stdout) as { modelKey?: string; path?: string }[];
      const trouve = liste.find((e) => (e.path ?? "").includes(dossier) || (e.modelKey ?? "").includes(dossier));
      if (trouve) return trouve.modelKey ?? trouve.path ?? null;
    } catch {
      /* LM Studio occupé : on réessaie */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

export function publier(qui: string, id: unknown): Travail {
  const p = projetDe(id, qui);
  const tem = lireTemoin();
  const b = tem ? base(tem.base) : undefined;
  const dossier = dossierProjet(p.id);
  if (!tem || !b || p.entrainement?.etat !== "fini") throw new ErreurEntrainement(409, t("Entraînez d'abord le modèle."));
  if (p.publie) throw new ErreurEntrainement(409, t("Ce modèle est déjà installé dans LM Studio. Retirez-le d'abord pour installer une nouvelle version."));
  const tr = occuper({ type: "publication", pour: qui, projet: p.id, message: t("Fusion de l'entraînement dans le modèle...") });
  void (async () => {
    const fusion = join(dossier, "fusion");
    const sortie = join(dossier, "sortie");
    rmSync(fusion, { recursive: true, force: true });
    rmSync(sortie, { recursive: true, force: true });
    try {
      const nom = nomDeDossier(b, p.nom);
      const cible = join(dossierNosModeles(), nom);
      if (tem.moteur === "mlx") {
        await lancer(pythonVenv(), ["-I", "-m", "mlx_lm", "fuse", "--model", dossierBase(b), "--adapter-path", join(dossier, "adaptateur"), "--save-path", fusion], { cwd: dossier, delai: 30 * 60_000 });
        /*
         * 8 bits : mesuré le 25/09/2026 (premier réglage essayé), le modèle
         * fondu en 8 bits (1,7 Go) a rendu les mêmes faits que l'adaptateur
         * (13 réponses justes sur 15 contre 12), le 4 bits (0,95 Go) en a
         * perdu deux. Avec le réglage retenu, chargé dans LM Studio (moteur
         * MLX) : 4 réponses justes sur 5, dont une question ordinaire.
         * Fusion, compression et rangement : 9 s.
         */
        tr.message = t("Compression du modèle (8 bits)...");
        await lancer(pythonVenv(), ["-I", "-m", "mlx_lm", "convert", "--hf-path", fusion, "--mlx-path", sortie, "-q", "--q-bits", "8"], { cwd: dossier, delai: 30 * 60_000 });
      } else {
        await lancer(pythonVenv(), ["-I", "-c", SCRIPT_NVIDIA_FONDRE, dossierBase(b), join(dossier, "adaptateur"), fusion], { cwd: dossier, delai: 60 * 60_000 });
        tr.message = t("Conversion au format GGUF...");
        mkdirSync(sortie, { recursive: true });
        /*
         * Sans `-I`, exceptionnellement : le mode isolé retire le dossier du
         * script de `sys.path` et ignore PYTHONPATH, et le convertisseur
         * importe alors ni son paquet `conversion` ni `gguf` (« No module
         * named 'conversion' », vu le 25/09/2026). `-s` écarte quand même les
         * paquets du compte. Cette étape a été essayée sur le Mac, avec les
         * mêmes versions (llama.cpp v0.5.0, torch 2.11.0, transformers
         * 4.57.6) : Qwen3 1.7B entraîné converti en Q8_0 en 19 s (1,83 Go),
         * chargé par LM Studio (moteur llama.cpp), faits appris retrouvés.
         */
        await lancer(pythonVenv(), ["-s", join(dossierLlamaCpp(), "convert_hf_to_gguf.py"), fusion, "--outfile", join(sortie, `${nom}-Q8_0.gguf`), "--outtype", "q8_0"], {
          cwd: dossier,
          delai: 60 * 60_000,
          // Le convertisseur importe `gguf` depuis ses propres sources, pas depuis pip.
          env: { ...environnement(), PYTHONPATH: join(dossierLlamaCpp(), "gguf-py") },
        });
      }
      // La licence Apache 2.0 du modèle de base voyage avec le modèle qui en dérive.
      cpSync(join(dossierBase(b), "LICENSE"), join(sortie, "LICENSE"));
      writeFileSync(
        join(sortie, "README.md"),
        `# ${p.nom}\n\nModèle entraîné sur la machine par OxoAI, le ${new Date().toISOString().slice(0, 10)}.\n\n` +
          `- Modèle de départ : ${b.depot} (révision ${b.revision}), licence Apache 2.0 (fichier LICENSE).\n` +
          `- Méthode : LoRA (${tem.moteur === "mlx" ? "MLX-LM" : "peft"}), ${p.entrainement?.exemplesAppris ?? 0} exemples, fondu et compressé en 8 bits.\n`,
      );
      tr.message = t("Rangement dans LM Studio...");
      mkdirSync(dossierNosModeles(), { recursive: true });
      try {
        renameSync(sortie, cible);
      } catch {
        // Autre disque : copie puis effacement.
        cpSync(sortie, cible, { recursive: true });
        rmSync(sortie, { recursive: true, force: true });
      }
      const cle = await cleLmStudio(nom);
      const frais = lireProjet(p.id) ?? p;
      frais.publie = { dossier: cible, cle, nom, date: new Date().toISOString(), octets: tailleDossier(cible) };
      ecrireProjet(frais);
      journaliser("entrainement.publie", qui, { projet: p.id, modele: cle ?? nom, octets: frais.publie.octets });
    } catch (err) {
      tr.message = expliquer(err);
      console.error("[entrainement] publication :", tr.message);
      await new Promise((r) => setTimeout(r, 4000));
    } finally {
      rmSync(fusion, { recursive: true, force: true });
      rmSync(sortie, { recursive: true, force: true });
    }
  })().finally(liberer);
  return tr;
}

/**
 * Retire le modèle de LM Studio : déchargé s'il est au repos, refusé s'il est
 * en train de répondre à quelqu'un, puis effacé. Seul un dossier rangé par
 * nous, sous `oxoai-entrainement`, peut être effacé.
 */
export async function retirer(qui: string, id: unknown): Promise<Projet> {
  const p = projetDe(id, qui);
  if (!p.publie) return p;
  if (travail?.projet === p.id) throw new ErreurEntrainement(409, t("Ce projet est en cours de traitement : attendez la fin pour le modifier."));
  const lms = await findLms();
  if (lms && p.publie.cle) {
    try {
      const { stdout } = await exec(lms, ["ps", "--json"], { timeout: 15_000 });
      const charge = (JSON.parse(stdout) as { modelKey?: string; identifier?: string; status?: string }[]).filter(
        (e) => e.modelKey === p.publie!.cle || (e.identifier ?? "").startsWith(p.publie!.cle!),
      );
      if (charge.some((e) => e.status && e.status !== "idle")) {
        throw new ErreurEntrainement(409, t("Ce modèle est en train de répondre à quelqu'un : réessayez dans un instant."));
      }
      for (const e of charge) await exec(lms, ["unload", e.identifier ?? e.modelKey!], { timeout: 30_000 }).catch(() => undefined);
    } catch (err) {
      if (err instanceof ErreurEntrainement) throw err;
    }
  }
  if (sous(dossierNosModeles(), p.publie.dossier) && existsSync(p.publie.dossier)) rmSync(p.publie.dossier, { recursive: true, force: true });
  // Plus aucun modèle entraîné : le dossier `oxoai-entrainement` part aussi, LM Studio redevient tel qu'avant.
  try {
    if (readdirSync(dossierNosModeles()).filter((n) => n !== ".DS_Store").length === 0) rmSync(dossierNosModeles(), { recursive: true, force: true });
  } catch {
    /* déjà absent */
  }
  journaliser("entrainement.retire", qui, { projet: p.id, modele: p.publie.cle ?? p.publie.nom });
  p.publie = null;
  ecrireProjet(p);
  return p;
}

/** Supprime le projet : le modèle rangé dans LM Studio d'abord, puis les exemples et l'adaptateur. */
export async function supprimer(qui: string, id: unknown): Promise<void> {
  const p = await retirer(qui, id);
  if (!sous(dossierProjets(), dossierProjet(p.id))) return;
  rmSync(dossierProjet(p.id), { recursive: true, force: true });
  journaliser("entrainement.projet_supprime", qui, { projet: p.id });
}

/**
 * Pour l'export RGPD (export.ts) : les projets de la personne, avec les
 * exemples qu'elle a écrits ou acceptés. Ni poids ni adaptateur : ce sont des
 * calculs, et le modèle installé se retrouve dans LM Studio sous son nom.
 */
export function projetsPourExport(qui: string) {
  return listerProjets(qui).map((p) => ({
    nom: p.nom,
    creeLe: p.cree,
    modifieLe: p.modifie,
    exemples: p.exemples,
    propositionsARelire: p.propositions,
    entrainement: p.entrainement
      ? { etat: p.entrainement.etat, date: p.entrainement.date, modeleDeDepart: p.entrainement.base, exemplesAppris: p.entrainement.exemplesAppris }
      : null,
    comparaison: p.comparaison,
    installeDansLMStudio: p.publie ? { nom: p.publie.nom, date: p.publie.date } : null,
  }));
}

/**
 * À l'effacement d'un compte (effacement.ts) : ses projets, leurs exemples,
 * l'adaptateur et le modèle rangé dans LM Studio. Oubliés jusqu'au 25/09/2026 :
 * un compte supprimé laissait ses exemples chiffrés sur le disque et son modèle
 * entraîné dans le sélecteur de toute l'équipe.
 *
 * Un calcul de la personne en cours est arrêté d'abord. Si le modèle installé
 * ne peut pas être retiré (il répond à quelqu'un), les exemples partent quand
 * même : ce sont eux, les données de la personne ; le reste est noté au
 * journal, par un nombre.
 */
export async function oublierPersonneEntrainement(qui: string): Promise<{ projets: number; modelesRestes: number }> {
  if (arreter(qui)) {
    for (let i = 0; i < 20 && travail?.pour === qui; i++) await new Promise((r) => setTimeout(r, 500));
  }
  let projets = 0;
  let modelesRestes = 0;
  for (const p of listerProjets(qui)) {
    try {
      await supprimer(qui, p.id);
    } catch {
      if (p.publie) modelesRestes++;
      if (sous(dossierProjets(), dossierProjet(p.id))) rmSync(dossierProjet(p.id), { recursive: true, force: true });
    }
    projets++;
  }
  return { projets, modelesRestes };
}

/** L'estimation de temps et de place pour un projet, avec les réglages. */
export function detailProjet(qui: string, id: unknown): Projet & { estimation: ReturnType<typeof estimer> } {
  const p = projetDe(id, qui);
  return { ...p, estimation: p.exemples.length >= EXEMPLES_MIN ? estimer(qui, id) : null };
}
