/**
 * Alléger ce qu'OpenCode envoie au modèle, sans rien lui retirer d'utile.
 *
 * ── Pourquoi ────────────────────────────────────────────────────────────────
 *
 * Constat du 25/09/2026 (Medhi, Qwen3 8B dans LM Studio, contexte de 28 160
 * jetons) : une tâche de OxoAI Code attendait plus de deux minutes avant le
 * premier mot. Relevé dans le journal de LM Studio le même jour : une demande
 * d'OpenCode de 18 141 jetons lue en 146,9 s (123 jetons par seconde), parce
 * que le modèle, partagé avec d'autres programmes et réglé pour une seule
 * demande à la fois, avait oublié entre deux appels ce qu'il avait déjà lu :
 * chaque retour d'un autre programme lui fait tout relire.
 *
 * Mesuré ensuite sur une instance jetable (tokeniseur de Qwen3, gabarit de
 * conversation compris), pour la demande la plus simple, sans historique :
 * 8 025 jetons, dont 2 098 de consignes d'OpenCode et 5 915 de définitions
 * d'outils (bash 1 334, task 867, todowrite 659, read 477, edit 462, webfetch
 * 329, grep 311, glob 266, write 250, skill 165, bibliothèque et réunions de
 * l'instance 718 alors qu'elles étaient vides). Tout cela est relu à chaque
 * appel dont le modèle a perdu le début.
 *
 * ── Ce qui est fait, et pourquoi de cette façon ─────────────────────────────
 *
 *  - Les consignes d'OpenCode (écrites pour son terminal : « One word answers
 *    are best », « /help », son site) sont remplacées par `CONSIGNES_CODE`,
 *    par sa configuration (`agent.build.prompt`, opencode.ts). Le bloc
 *    d'environnement (dossier, date, système) qu'il ajoute reste.
 *  - Les descriptions des outils livrés sont raccourcies ici, dans le relais
 *    de la passerelle (chat.ts), et **seulement** quand elles commencent par
 *    le texte d'OpenCode 1.18.32 : une autre version, ou un autre client, garde
 *    les siennes. Les paramètres ne changent pas d'un caractère : l'outil
 *    s'appelle et se comporte exactement pareil. OpenCode ne permet pas de les
 *    réécrire par sa configuration (seulement par un greffon, du code exécuté
 *    chez lui ; écarté).
 *  - Le remplacement est déterministe : d'un appel à l'autre, le début de la
 *    demande reste identique, ce que le modèle sait réutiliser.
 *
 * Écrit en anglais, comme tout ce qu'OpenCode envoie au modèle (paramètres des
 * outils, environnement) : un petit modèle suit mieux des consignes d'une
 * seule langue. La réponse, elle, suit la langue de la personne (consigne
 * explicite).
 */

/** Consignes de l'agent de code, à la place de celles d'OpenCode (voir l'en-tête). */
export const CONSIGNES_CODE = [
  "You are the coding agent of this workspace. You help the user with software tasks in the project folder, with the tools provided.",
  "",
  "- Answer in the language the user writes in. Be concise and direct: no preamble, no summary unless asked.",
  "- Act with the tools. Read a file before editing it, prefer editing existing files, create files only when needed. Stay inside the project folder.",
  // Ajouté le 23/10/2026 (capture sous Windows : « /app/metier.js » refusé, hors du dossier du projet).
  "- File paths are inside the project folder (the working directory). A path given relative to the project (app/main.js) means <project folder>/app/main.js. An absolute path from another system (/app, /home, C:\\) is not the project: never use one.",
  "- Find files with glob and grep, read them with read, change them with edit or write. Use bash for commands (build, tests, package managers, git), not to read or write files.",
  "- For work with three steps or more, keep a short todo list with todowrite and update it as you go (exactly one item in_progress).",
  "- Use task only for a large, separate piece of work. For a simple search or a few files, use glob, grep and read yourself: a sub-agent reads everything again.",
  "- Follow the project's conventions: look at neighbouring files, never assume a library is installed, add no code comments unless asked.",
  "- After a change, run the project's checks (tests, typecheck, lint) when there are any, and say plainly what you could not verify.",
  "- Never commit, push or delete data unless the user asks. Never guess URLs.",
  // Remises le 26/09/2026 (revue du 25/09) : l'allègement avait retiré ces trois règles des consignes d'OpenCode.
  "- Never expose, print or log secrets, keys, tokens or passwords, and never read them from files or the environment unless the user asks for that exact file.",
  "- Never run destructive git commands (push --force, reset --hard, clean -f, branch -D, checkout -- .) unless the user explicitly asks. Never skip hooks (--no-verify) or bypass signing.",
  "- Commands and file changes wait for the user's approval. A refusal is a decision: do not retry the same action another way; say what you could not do.",
  "- When you mention code, give file_path:line.",
].join("\n");

interface OutilOpenAI {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
}

/**
 * Descriptions courtes des outils livrés d'OpenCode. `debut` : le début exact
 * de sa description d'origine (relevé le 25/09/2026 sur 1.18.32) ; sans lui,
 * rien n'est remplacé. `garder` : ce qui, dans l'originale, dépend du poste ou
 * de la configuration et doit rester (système, dossier temporaire, agents
 * disponibles).
 */
const COURTES: Record<string, { debut: string; texte: string; garder?: (originale: string) => string }> = {
  bash: {
    debut: "Executes a given bash command in a persistent shell session",
    texte:
      "Runs a shell command in the project folder (persistent shell). Use it for terminal work: build, tests, package managers, git. " +
      "Do not use it to read, write, edit or search files: use read, write, edit, glob and grep. Quote paths that contain spaces. " +
      "Use `workdir` instead of `cd dir && ...`. Default timeout 120000 ms; long output is cut and saved to a file you can read. " +
      "Never commit, push or change git config unless the user asks.",
    garder: (o) =>
      [/^Be aware: .*$/m, /^Use `[^`]+` for temporary work outside the workspace\..*$/m]
        .map((motif) => o.match(motif)?.[0])
        .filter(Boolean)
        .join("\n"),
  },
  task: {
    debut: "Launch a new agent to handle complex, multistep tasks autonomously.",
    texte:
      "Starts a sub-agent for a large, separate piece of work. It starts from an empty context, works alone and returns one message " +
      "(the user does not see it: summarize it yourself). For a simple search or a few files, use glob, grep and read instead. " +
      "Give `description` (3 to 5 words, shown to the user), a detailed `prompt` saying exactly what to do and what to return, " +
      "and `subagent_type`. Pass `task_id` to resume a previous sub-agent.",
    garder: (o) => {
      const i = o.indexOf("Available agent types");
      return i >= 0 ? o.slice(i).trim() : "";
    },
  },
  todowrite: {
    debut: "Create and maintain a structured task list for the current coding session.",
    texte:
      "Creates or updates the todo list shown to the user. Use it for work with three steps or more: list the steps, mark one " +
      "`in_progress` before starting it, `completed` as soon as it is really done (checks included), `cancelled` if dropped. " +
      "Send the whole list each time. Skip it for a single simple change or a question.",
  },
  read: {
    debut: "Read a file or directory from the local filesystem.",
    texte:
      // « inside the project folder » (23/10/2026) : « absolute » seul faisait écrire « /app/PLAN.md » pour « app/PLAN.md » (application.ts).
      "Reads a file or a directory. `filePath` is absolute, inside the project folder (the working directory). Returns up to 2000 lines, each prefixed with its number as `<line>: `; " +
      "use `offset` (1-indexed) and `limit` for other parts. Lines over 2000 characters are cut. Also reads images and PDFs.",
  },
  edit: {
    debut: "Performs exact string replacements in files.",
    texte:
      "Replaces exact text in a file. Read the file first. `oldString` must match the file exactly (keep the indentation shown after " +
      "the `<line>: ` prefix, never include the prefix) and be unique, or set `replaceAll`. Prefer editing existing files.",
  },
  write: {
    debut: "Writes a file to the local filesystem.",
    texte:
      "Writes a whole file, replacing it if it exists. Read an existing file first, and prefer edit to change it. " +
      "Do not create documentation files unless asked.",
  },
  grep: {
    debut: "- Fast content search tool",
    texte: "Searches file contents with a regular expression. `include` filters files (for example \"*.ts\"). Returns matching files and lines.",
  },
  glob: {
    debut: "- Fast file pattern matching tool",
    texte: "Finds files by name pattern (for example \"**/*.ts\" or \"src/**/*.tsx\"). Returns matching paths.",
  },
  webfetch: {
    debut: "- Fetches content from a specified URL",
    texte: "Fetches a web page (a URL given by the user or found in the project) and returns it as markdown, text or html. Read-only.",
  },
};

/**
 * Les outils d'une demande d'OpenCode, avec des descriptions courtes pour ceux
 * qu'on reconnaît (voir `COURTES`). Tout le reste est rendu tel quel, objet
 * compris : un outil inconnu, ou une description qui a changé, n'est pas
 * touché.
 */
export function compacterOutils<T>(outils: T[]): T[] {
  return outils.map((outil) => {
    const o = outil as OutilOpenAI;
    const nom = o?.function?.name;
    const originale = o?.function?.description;
    const court = nom ? COURTES[nom] : undefined;
    if (!court || typeof originale !== "string" || !originale.startsWith(court.debut)) return outil;
    const garde = court.garder?.(originale) ?? "";
    return { ...o, function: { ...o.function, description: garde ? `${court.texte}\n\n${garde}` : court.texte } } as T;
  });
}
