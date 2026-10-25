/*
 * Un faux `codex`, pour la batterie de sécurité (scripts/securite.mjs,
 * section 6 sexies, 27/09/2026).
 *
 * La batterie ne lance jamais le vrai `codex`, peut-être installé et connecté
 * sur le poste, et ne se connecte à aucun compte. Celui-ci imite ce dont la
 * passerelle se sert (gateway/src/codex.ts) :
 *
 *  - `--version` : « codex-cli 0.150.0-essai » ;
 *  - `login status` : « Logged in using ChatGPT », code 0, si `connecte`
 *    existe dans son dossier d'essai ; sinon « Not logged in », code 1 ;
 *  - `login` : pose `connecte` après une seconde, comme une personne qui
 *    termine le parcours dans son navigateur ;
 *  - `exec --json … -` : lit la demande sur l'entrée standard et rend un flux
 *    JSONL de la forme relevée le 27/09/2026 (codex-rs/exec/src/exec_events.rs,
 *    page « Non-interactive mode ») : session, étape, raisonnement, commande,
 *    changement de fichier, liste de tâches, message, consommation. Une
 *    demande qui porte « attente-longue » ne rend rien pendant 60 s (arrêt
 *    sur demande) ; « echec-essai » rend un `turn.failed`.
 *
 * Chaque appel est noté dans `appels.jsonl` : arguments, dossier courant,
 * numéro de processus, noms des variables d'environnement reçues, et celles
 * qui portent un secret de l'hôte. Le dossier d'essai est donné par
 * l'enveloppe shell (`FAUX_CODEX_AUX`) : la passerelle ne transmet à `codex`
 * qu'une liste fermée de variables.
 *
 * Il n'ouvre aucun réseau et ne touche à aucun `~/.codex`.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const AUX = process.env.FAUX_CODEX_AUX;
const args = process.argv.slice(2);
const noter = (extra = {}) => {
  if (!AUX) return;
  const secrets = Object.entries(process.env)
    .filter(([nom, v]) => nom === "OXOAI_CANARI_SECRET" || nom === "OXOAI_TOKEN" || nom.startsWith("OXOAI_OPENCODE") || nom === "OPENAI_API_KEY" || nom === "CODEX_API_KEY" || String(v).includes("canari-secret"))
    .map(([nom]) => nom);
  appendFileSync(join(AUX, "appels.jsonl"), JSON.stringify({ args, cwd: process.cwd(), pid: process.pid, env: Object.keys(process.env), secrets, ...extra }) + "\n");
};
const ligne = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (args[0] === "--version") {
  noter();
  process.stdout.write("codex-cli 0.150.0-essai\n");
} else if (args[0] === "login" && args[1] === "status") {
  noter();
  if (AUX && existsSync(join(AUX, "connecte"))) {
    process.stderr.write("Logged in using ChatGPT\n");
  } else {
    process.stderr.write("Not logged in\n");
    process.exitCode = 1;
  }
} else if (args[0] === "login") {
  noter();
  setTimeout(() => {
    if (AUX) writeFileSync(join(AUX, "connecte"), "oui");
    process.stderr.write("Successfully logged in\n");
  }, 1000);
} else if (args[0] === "exec") {
  let demande = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (m) => (demande += m));
  process.stdin.on("end", () => {
    noter({ demande });
    const reprise = args.includes("resume");
    const session = reprise ? args[args.indexOf("-") - 1] : "0199a213-81c0-7800-8aa1-bbab2a035a53";
    ligne({ type: "thread.started", thread_id: session });
    ligne({ type: "turn.started" });
    process.stdout.write("avertissement qui n'est pas du JSON\n");
    if (demande.includes("attente-longue")) {
      setTimeout(() => ligne({ type: "turn.completed", usage: {} }), 60_000);
      return;
    }
    if (demande.includes("echec-essai")) {
      ligne({ type: "turn.failed", error: { message: "limite d'usage atteinte (essai)" } });
      process.exitCode = 1;
      return;
    }
    ligne({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "Je regarde le dossier." } });
    ligne({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc ls", status: "in_progress" } });
    ligne({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "bash -lc ls", aggregated_output: "README.md\n", exit_code: 0, status: "completed" } });
    ligne({ type: "item.completed", item: { id: "item_2", type: "file_change", changes: [{ path: join(process.cwd(), "NOTES.md"), kind: "add" }, { path: join(process.cwd(), "README.md"), kind: "update" }], status: "completed" } });
    ligne({ type: "item.completed", item: { id: "item_3", type: "todo_list", items: [{ text: "Lire le dossier", completed: true }, { text: "Écrire les notes", completed: false }] } });
    ligne({ type: "item.completed", item: { id: "item_4", type: "agent_message", text: `${reprise ? "Suite" : "Fait"} : ${demande.slice(0, 60)}` } });
    ligne({ type: "turn.completed", usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0 } });
  });
} else {
  noter();
  process.stderr.write(`faux codex : commande inconnue ${args.join(" ")}\n`);
  process.exitCode = 2;
}
