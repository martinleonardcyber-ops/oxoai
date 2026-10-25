/**
 * L'analyse des fichiers Python écrits par OxoAI Code (controleCode.ts), sans
 * rien exécuter : le programme ci-dessous lit le texte (`ast.parse`) et
 * cherche les modules avec `importlib.util.find_spec` sur le seul nom de tête,
 * qui consulte les dossiers sans importer le module. Il est lancé en mode isolé
 * (`python3 -I`), avec le Python du système : jamais un interpréteur du
 * projet, que l'agent aurait pu écrire.
 *
 * Ce qu'il relève (ajouté le 26/09/2026, « bon sur tous les domaines de code ») :
 *  - les erreurs de syntaxe, avec la ligne ;
 *  - les noms employés qui ne sont définis nulle part dans le fichier (ni
 *    importés, ni affectés, ni paramètres, ni fonctions natives) : une fonction
 *    inventée, une faute de frappe. Un fichier avec `from x import *` n'est pas
 *    jugé sur ce point ;
 *  - `from module import nom` où le module est un fichier du projet qui ne
 *    définit pas ce nom ;
 *  - un module ni installé (Python du système, ou `.venv` du projet), ni dans
 *    le projet, ni listé dans requirements.txt ou pyproject.toml. Un import
 *    placé dans un `try` (dépendance facultative) n'est pas relevé.
 *
 * Entrée : argv[1] = racine du projet, argv[2:] = fichiers. Sortie : JSON
 * [{f, l, k, m}] où k vaut « syntaxe », « nom », « import » ou « module ».
 */
export const ANALYSE_PYTHON = String.raw`
import ast, builtins, glob, importlib.util, json, os, re, sys

racine = os.path.abspath(sys.argv[1])
fichiers = sys.argv[2:]
for sp in glob.glob(os.path.join(racine, "*venv*", "lib", "python*", "site-packages")):
    sys.path.append(sp)

DUNDERS = {"__name__", "__file__", "__doc__", "__builtins__", "__spec__", "__loader__", "__package__",
           "__path__", "__all__", "__dict__", "__class__", "__annotations__", "__debug__", "__qualname__", "__module__"}
NATIFS = set(dir(builtins)) | DUNDERS
# Paquets dont le nom d'import diffère du nom d'installation.
ALIAS = {"pil": "pillow", "cv2": "opencv_python", "yaml": "pyyaml", "sklearn": "scikit_learn", "bs4": "beautifulsoup4",
         "dateutil": "python_dateutil", "dotenv": "python_dotenv", "jwt": "pyjwt", "serial": "pyserial", "magic": "python_magic",
         "fitz": "pymupdf", "docx": "python_docx", "pptx": "python_pptx", "attr": "attrs", "google": "google"}

def normalise(nom):
    return re.sub(r"[-_.]+", "_", nom.strip().lower())

# Un projet qui déclare ses dépendances quelque part (à la racine ou plus bas) en
# tient la liste lui-même, souvent installée ailleurs (Docker, serveur) : ses
# modules ne sont pas jugés. Mesuré le 26/09/2026 sur un vrai projet (359
# fichiers) : 774 modules « introuvables », tous déclarés dans des sous-dossiers.
# Le contrôle des modules ne vaut que pour un projet qui n'en déclare aucun.
DECLARATIONS = ("requirements.txt", "requirements-dev.txt", "requirements_dev.txt", "pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "environment.yml", "poetry.lock")
projet_declare = False
for dossier_courant, sous_dossiers, noms in os.walk(racine):
    sous_dossiers[:] = [d for d in sous_dossiers if not d.startswith(".") and d not in ("node_modules", "__pycache__") and "venv" not in d]
    if any(n in DECLARATIONS for n in noms) and dossier_courant != racine:
        projet_declare = True
        break

declares = set()
for chemin in ("requirements.txt", "requirements-dev.txt", "requirements_dev.txt"):
    try:
        for ligne in open(os.path.join(racine, chemin), encoding="utf-8"):
            ligne = ligne.split("#")[0].strip()
            m = re.match(r"([A-Za-z0-9][A-Za-z0-9._-]*)", ligne)
            if m:
                declares.add(normalise(m.group(1)))
    except OSError:
        pass
try:
    texte = open(os.path.join(racine, "pyproject.toml"), encoding="utf-8").read()
    for m in re.finditer(r"[\"']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:[<>=!~;\[\"']|$)", texte):
        declares.add(normalise(m.group(1)))
except OSError:
    pass

def lies(arbre):
    noms = set()
    for n in ast.walk(arbre):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            noms.add(n.name)
        elif isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
            noms.add(n.id)
        elif isinstance(n, ast.arg):
            noms.add(n.arg)
        elif isinstance(n, ast.alias):
            noms.add((n.asname or n.name).split(".")[0])
        elif isinstance(n, (ast.Global, ast.Nonlocal)):
            noms.update(n.names)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            noms.add(n.name)
        else:
            for attribut in ("name", "rest"):
                v = getattr(n, attribut, None)
                if type(n).__name__ in ("MatchAs", "MatchStar", "MatchMapping", "TypeVar", "ParamSpec", "TypeVarTuple") and isinstance(v, str):
                    noms.add(v)
    return noms

def definis_en_haut(arbre):
    noms = set()
    def parcourir(corps):
        for n in corps:
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                noms.add(n.name)
            elif isinstance(n, (ast.Import, ast.ImportFrom)):
                for a in n.names:
                    noms.add((a.asname or a.name).split(".")[0])
            elif isinstance(n, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                cibles = n.targets if isinstance(n, ast.Assign) else [n.target]
                for c in cibles:
                    for x in ast.walk(c):
                        if isinstance(x, ast.Name):
                            noms.add(x.id)
            elif isinstance(n, (ast.If, ast.Try, ast.With, ast.For, ast.While)):
                for champ in ("body", "orelse", "finalbody"):
                    parcourir(getattr(n, champ, []) or [])
                for h in getattr(n, "handlers", []) or []:
                    parcourir(h.body)
    parcourir(arbre.body)
    return noms

def fichier_local(module, dossiers):
    parties = module.split(".")
    for d in dossiers:
        base = os.path.join(d, *parties)
        for candidat in (base + ".py", os.path.join(base, "__init__.py")):
            if os.path.isfile(candidat):
                return candidat
        if os.path.isdir(base):
            return base
    return None

sortie = []
for f in fichiers:
    try:
        source = open(f, encoding="utf-8-sig").read()
        arbre = ast.parse(source, f)
    except SyntaxError as e:
        sortie.append({"f": f, "l": e.lineno or 0, "k": "syntaxe", "m": e.msg or "syntaxe"})
        continue
    except Exception:
        continue
    parents = {}
    for n in ast.walk(arbre):
        for enfant in ast.iter_child_nodes(n):
            parents[enfant] = n
    def dans_un_try(n):
        while n in parents:
            n = parents[n]
            if isinstance(n, ast.Try) or type(n).__name__ == "TryStar":
                return True
        return False

    etoile = any(isinstance(n, ast.ImportFrom) and any(a.name == "*" for a in n.names) for n in ast.walk(arbre))
    if not etoile and "__getattr__" not in source:
        connus = lies(arbre) | NATIFS
        vus = set()
        for n in ast.walk(arbre):
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id not in connus and n.id not in vus:
                vus.add(n.id)
                sortie.append({"f": f, "l": n.lineno, "k": "nom", "m": n.id})
                if len(vus) >= 8:
                    break

    dossier = os.path.dirname(os.path.abspath(f))
    for n in ast.walk(arbre):
        if isinstance(n, ast.Import):
            demandes = [(a.name, None) for a in n.names]
        elif isinstance(n, ast.ImportFrom) and n.module and n.level == 0:
            demandes = [(n.module, [a.name for a in n.names])]
        elif isinstance(n, ast.ImportFrom) and n.level > 0:
            base = dossier
            for _ in range(n.level - 1):
                base = os.path.dirname(base)
            chemin = fichier_local(n.module, [base]) if n.module else os.path.join(base, "__init__.py")
            if n.module and chemin is None:
                sortie.append({"f": f, "l": n.lineno, "k": "import", "m": "." * n.level + n.module + " : fichier introuvable dans le projet"})
                continue
            demandes = []
            if chemin and os.path.isfile(chemin):
                try:
                    defs = definis_en_haut(ast.parse(open(chemin, encoding="utf-8-sig").read()))
                    dossier_mod = os.path.dirname(chemin)
                    for a in n.names:
                        if a.name != "*" and a.name not in defs and not fichier_local(a.name, [dossier_mod]):
                            sortie.append({"f": f, "l": n.lineno, "k": "import", "m": os.path.relpath(chemin, racine) + " ne définit pas " + a.name})
                except Exception:
                    pass
            continue
        else:
            continue
        if dans_un_try(n):
            continue
        for module, noms in demandes:
            tete = module.split(".")[0]
            chemin = fichier_local(module, [dossier, racine])
            if chemin:
                if noms and os.path.isfile(chemin):
                    try:
                        defs = definis_en_haut(ast.parse(open(chemin, encoding="utf-8-sig").read()))
                        dossier_mod = os.path.dirname(chemin)
                        for x in noms:
                            if x != "*" and x not in defs and not fichier_local(x, [dossier_mod]):
                                sortie.append({"f": f, "l": n.lineno, "k": "import", "m": os.path.relpath(chemin, racine) + " ne définit pas " + x})
                    except Exception:
                        pass
                continue
            if tete in sys.builtin_module_names or tete in getattr(sys, "stdlib_module_names", ()):
                continue
            try:
                trouve = importlib.util.find_spec(tete) is not None
            except Exception:
                trouve = True
            if not trouve and not projet_declare and normalise(tete) not in declares and normalise(ALIAS.get(tete.lower(), tete)) not in declares:
                sortie.append({"f": f, "l": n.lineno, "k": "module", "m": tete})
print(json.dumps(sortie))
`;
