/*
 * La scène des captures en japonais (scripts/captures/capturer.mjs, 28/09/2026).
 *
 * Même histoire que les autres langues : Maple & Rye, une boulangerie de
 * trois boutiques et un fournil, Alex Morgan (propriétaire), Priya (compta),
 * le moulin Millstone Mills. Les noms propres restent tels quels, comme dans
 * la version chinoise ; tout le reste est écrit en japonais. Tout est
 * inventé : aucune personne, entreprise ni adresse réelle (domaine
 * `.example`, réservé par la RFC 2606).
 */
export default {
  localeNavigateur: "ja-JP",
  personne: { nom: "Alex Morgan", email: "alex@maple-rye.example", motDePasse: "Captures-Essai-2026-ja!" },
  modeleChat: "qwen/qwen3.5-9b",
  modeleEmbed: "text-embedding-nomic-embed-text-v1.5",
  modelesMistral: ["mistral-medium-latest", "magistral-medium-latest"],

  /*
   * Les thèmes du faux modèle d'embeddings : une composante par ligne, qui
   * compte si l'un de ses mots est présent. La question de la démonstration
   * touche « 購買 », « 承認 », « 見積 » (et « 配送 » par le devis joint) :
   * la politique d'achat sort première (0,77 à 0,89), la liste des
   * fournisseurs deuxième (0,58 à 0,75), le reste sous le seuil de la
   * passerelle (0,55).
   */
  themes: [["購買"], ["承認"], ["見積"], ["仕入先"], ["卸売"], ["配送"], ["休暇"], ["アレルゲン"], ["従業員"]],

  /** Réponse à tout ce qui n'est pas la scène (essai du modèle, titres). */
  reponseCourte: "承知しました。",

  base: {
    nom: "社内ハンドブック",
    description: "",
    documents: [
      {
        nom: "購買規程.md",
        texte: `# 購買規程

Maple & Rye のすべての発注に適用します（2026年3月改訂）。

- 2,000ユーロ（税抜）を超える購買には、オーナー（Alex）と経理（Priya）の2名の承認が必要です。
- 継続して仕入れている品目で、見積価格が現行契約より8%を超えて上がる場合は、発注前に再交渉します。
- 見積書は仕入先リストに登録済みの仕入先からのみ受け付けます。納品と配送の条件は見積書に明記してもらいます。
- 支払条件は原則として30日以内とします。
`,
      },
      {
        nom: "仕入先リスト.md",
        texte: `# 仕入先リスト

購買担当：Priya（見積書の提出先）

- Millstone Mills：有機T65小麦粉。30日払い、毎週火曜日に配送。現行契約価格は1kgあたり0.85ユーロ（2026年3月更新）。
- Green Valley Dairy：バター、生クリーム。30日払い、月曜と木曜に配送。
- Harbour Packaging：箱、紙袋。45日払い、隔週で配送。
`,
      },
      {
        nom: "卸売条件.md",
        texte: `# 卸売条件

- 卸売の注文は、前日の午後2時まで受け付けます。
- 配送便は毎朝、旧市街ルートが6時30分、リバーサイドルートが7時15分にパン工房を出発します。
- 最低注文額は60ユーロです。請求書の支払期限は発行から30日です。
`,
      },
      {
        nom: "従業員ハンドブック.md",
        texte: `# 従業員ハンドブック

- 有給休暇は年25日です。入社1年目は月割りで付与します。
- 休暇の申請は2週間前までにシフト表で行ってください。
- 早朝シフトは5時開始、パン工房の鍵はシフト責任者が管理します。
`,
      },
      {
        nom: "アレルゲン手順.md",
        texte: `# アレルゲン手順

- 表示が必要な14品目のアレルゲン（小麦、乳、卵、ナッツ類、ごまなど）は、すべての商品ラベルに記載します。
- ナッツを使う商品は、専用の台と道具で最後に仕込みます。
- レシピを変えたときは、その日のうちにラベルを作り直します。
`,
      },
    ],
  },

  /** La démonstration : le devis joint, la question tapée, la réponse (faux modèle). */
  demo: {
    pieceJointe: {
      nom: "Millstone見積書-2026-10.md",
      texte: `# 見積書 Q-2026-1014

Millstone Mills → Maple & Rye

- 有機T65小麦粉 4,800kg（25kg袋 × 192）
- 単価：1kgあたり0.94ユーロ
- 合計：4,512ユーロ（税抜）
- 支払条件：請求書発行から30日
- 配送：2026年10月から毎週火曜日
- 有効期限：2026年10月14日
`,
    },
    question: "この見積書は当社の購買規程に沿っていますか？誰の承認が必要ですか？",
  },

  reponses: [
    {
      declencheur: "購買規程に沿っていますか",
      reflexion: "見積書の合計と単価を、購買規程の基準額・値上げ上限、仕入先リストの記載と照らし合わせる。",
      avantPremierMotMs: 700,
      rythmeMs: 35,
      texte: `おおむね沿っていますが、署名の前に確認すべき点が2つあります。

- **2名の承認が必要です。** 合計は4,512ユーロ（税抜）で、2,000ユーロの基準額を超えるため、Alex（オーナー）とPriya（経理）の両方の承認が必要です {{doc:購買規程.md}}。
- **値上げ幅が上限を超えています。** 1kgあたり0.94ユーロは現行契約の0.85ユーロより10.6%高く、再交渉が必要になる8%の上限を超えています {{doc:購買規程.md}}。
- **その他の条件は問題ありません。** Millstone Millsは仕入先リストに登録済みで、有機T65小麦粉、30日払い、火曜日の配送もリストの記載と一致しています {{doc:仕入先リスト.md}}。

Millstoneに1kgあたり0.92ユーロ以下での再提示を依頼し、そのうえで2名の承認に回すことをおすすめします。返信の下書きを作成しましょうか？`,
    },
    {
      declencheur: "来週の仕込み",
      texte: "来週の仕込み量は、先週の販売数に天候の予報を加味して、バゲットを1日あたり約10%増やすのがよさそうです。",
    },
    { texte: "承知しました。" },
  ],

  /** Un appel à Mistral (clé factice, faux serveur) : la ligne « リモート » de « 自分の使用量 ». */
  questionMistral: "来週の仕込み量について、先週の販売数から提案してください。",

  /** Les Chats plus anciens de la barre latérale (du plus récent au plus ancien), rangés par la passerelle. */
  chats: [
    {
      ilYaHeures: 20,
      question: "当店のラベルに表示が必要なアレルゲンは何ですか？",
      reponse: "表示が必要な14品目のアレルゲン（小麦、乳、卵、ナッツ類、ごまなど）を、すべての商品ラベルに記載します。レシピを変えたときは、その日のうちにラベルを作り直してください。",
    },
    {
      ilYaHeures: 44,
      question: "月曜のチームミーティングのメモを3点に要約してください",
      reponse: "1. 10月からリバーサイド店の開店を7時に早めます。\n2. 秋の新作（かぼちゃのブリオッシュ）は来週から試作します。\n3. 早朝シフトの交代要員を1名募集します。",
    },
    {
      ilYaHeures: 70,
      question: "卸売の配送便はパン工房を何時に出発しますか？",
      reponse: "毎朝、旧市街ルートが6時30分、リバーサイドルートが7時15分にパン工房を出発します。注文の締め切りは前日の午後2時です。",
    },
    {
      ilYaHeures: 95,
      question: "従業員の有給休暇は年に何日ありますか？",
      reponse: "有給休暇は年25日です。入社1年目は月割りで付与されます。申請は2週間前までにシフト表で行ってください。",
    },
  ],

  /** OxoAI Code : le projet, la demande, et la séance que joue le faux OpenCode. */
  code: {
    projet: "maple-rye-orders",
    fichiers: {
      "package.json": `{\n  "name": "maple-rye-orders",\n  "private": true,\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n`,
      "src/orders/deliverySlot.ts": `// 卸売注文の配送日を決める\nexport const CUTOFF_HOUR = 14;\n\nexport function deliverySlot(orderedAt: Date): Date {\n  const slot = new Date(orderedAt);\n  slot.setDate(slot.getDate() + 1);\n  slot.setHours(6, 30, 0, 0);\n  return slot;\n}\n`,
      "src/orders/deliverySlot.test.ts": `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { deliverySlot } from "./deliverySlot.ts";\n\ntest("翌朝6時30分に配送", () => {\n  const slot = deliverySlot(new Date("2026-09-28T09:00:00"));\n  assert.equal(slot.getDate(), 29);\n});\n`,
    },
    demande: "午後2時以降に入った卸売の注文は、翌々日の配送にしてください。deliverySlot を修正して、テストを追加してください。",
    taches: ["現在の配送枠のロジックを読む", "卸売注文に午後2時の締め切りを追加する", "新しいルールをテストで確認する", "テストを実行する"],
    reflexion: "まず deliverySlot とそのテストを読み、締め切り時刻の扱いを確認する。",
    nouveauTest: "午後2時以降の注文は翌々日に配送",
  },

  /** L'agent toujours actif (reçu par Chrome à la place de la réponse de la passerelle : il vit dans OpenClaw). */
  agents: {
    employe: {
      nom: "受注デスク",
      poste: "卸売の注文を受け付け、毎朝の配送ルートを組み、未払いの請求書を確認します。",
      description: "卸売の注文と配送ルート、請求書の確認",
      missions: [
        { nom: "朝の配送ルート", consigne: "本日の卸売注文を2つのルートに分け、「注文」チャンネルに投稿する。", rythme: "chaque-jour", heure: "05:45" },
        { nom: "未払い請求書の確認", consigne: "支払期日を30日以上過ぎた請求書を探し、丁寧な督促メールを下書きする。", rythme: "jours-ouvres", heure: "09:00" },
      ],
    },
    activite: [
      {
        mission: "未払い請求書の確認",
        quand: "2026-09-25T09:00:00+02:00",
        dureeMs: 38_000,
        resume: "支払期日を30日以上過ぎた請求書が2件あります：ハーバーカフェ（INV-0917、342.60ユーロ、36日）とコーナーデリ（INV-0922、118.20ユーロ、31日）。丁寧な督促メールを2通、メールボックスに下書きしました。承認をお待ちしています。",
      },
      {
        mission: "朝の配送ルート",
        quand: "2026-09-25T05:45:00+02:00",
        dureeMs: 38_000,
        resume: "本日の卸売注文は14件で、2ルートに分けました：旧市街（8か所、6:30）とリバーサイド（6か所、7:15）。ハーバーカフェの注文は昨日のメールを受けてバゲット40本に変更しました。ルートは「注文」チャンネルに投稿済みです。",
      },
      {
        mission: "未払い請求書の確認",
        quand: "2026-09-24T09:00:00+02:00",
        dureeMs: 47_000,
        resume: "期日を過ぎた請求書が1件あります：ハーバーカフェ（INV-0917、35日）。督促メールを下書きしました。",
      },
      {
        mission: "朝の配送ルート",
        quand: "2026-09-24T05:45:00+02:00",
        dureeMs: 47_000,
        resume: "注文11件、2ルート。グリーンリーフ・ビストロから早めの配送（6:15）の依頼があったため、旧市街ルートの最初の配送先にしました。",
      },
    ],
    /** Les autres agents (collection « agents »), toujours actifs eux aussi. */
    autres: [
      {
        nom: "店舗アシスタント",
        description: "商品、アレルゲン、作業手順についての質問に答えます",
        instructions: "店舗スタッフからの商品、アレルゲン、作業手順についての質問に、社内ハンドブックをもとに短く答えてください。",
        visibility: "organisation",
      },
      {
        nom: "仕入先ウォッチ",
        description: "仕入先の見積書を購買規程と照らし合わせます",
        instructions: "仕入先から届いた見積書を、社内ハンドブックの購買規程と仕入先リストに照らして確認し、問題点を短く伝えてください。",
        visibility: "personnel",
      },
    ],
  },

  /** « モデルをトレーニング » : le jeu d'exemples (au moins dix). */
  entrainement: {
    nom: "Maple & Rye",
    exemples: [
      ["Maple & Rye はいつ創業しましたか？", "Maple & Rye は2014年に Alex Morgan がマーケット通りで創業しました。"],
      ["Maple & Rye を創業したのは誰ですか？", "Alex Morgan が2014年に Maple & Rye を創業しました。"],
      ["Maple & Rye には何店舗ありますか？", "マーケット通り、旧市街、リバーサイドの3店舗と、パン工房が1つあります。"],
      ["パン工房はどこにありますか？", "パン工房はリバーサイド店の裏手にあり、毎朝5時から仕込みを始めます。"],
      ["卸売の注文の締め切りは何時ですか？", "前日の午後2時までです。それ以降の注文は翌々日の配送になります。"],
      ["卸売の最低注文額はいくらですか？", "最低注文額は60ユーロです。"],
      ["小麦粉はどこから仕入れていますか？", "有機T65小麦粉は Millstone Mills から仕入れ、毎週火曜日に届きます。"],
      ["2,000ユーロを超える購買は誰が承認しますか？", "オーナーの Alex と経理の Priya の2名が承認します。"],
      ["有給休暇は年に何日ですか？", "有給休暇は年25日です。"],
      ["アレルゲンの表示はどうしていますか？", "表示が必要な14品目のアレルゲンを、すべての商品ラベルに記載しています。"],
      ["ナッツを使う商品はどう仕込みますか？", "専用の台と道具を使い、その日の最後に仕込みます。"],
      ["リバーサイド店は何時に開店しますか？", "10月から7時に開店します。"],
    ],
  },
};
