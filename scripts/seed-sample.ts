/**
 * Seed the KNF database with sample provisions for testing.
 *
 * Inserts representative provisions from KNF_Rekomendacje (D on IT risk),
 * KNF_Wytyczne (outsourcing), and KNF_Stanowiska so MCP tools can be tested
 * without a full ingestion run.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["KNF_DB_PATH"] ?? "data/knf.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

interface SourcebookRow {
  id: string;
  name: string;
  description: string;
}

const sourcebooks: SourcebookRow[] = [
  {
    id: "KNF_REKOMENDACJE",
    name: "KNF Rekomendacje",
    description:
      "Rekomendacje KNF dotyczące dobrych praktyk w zakresie zarządzania ryzykiem, bezpieczeństwa IT, i ładu korporacyjnego. (KNF recommendations on risk management, IT security, and corporate governance.)",
  },
  {
    id: "KNF_WYTYCZNE",
    name: "KNF Wytyczne",
    description:
      "Wytyczne KNF precyzujące oczekiwania nadzorcze w obszarach takich jak outsourcing i zarządzanie ciągłością działania. (KNF guidelines specifying supervisory expectations in areas such as outsourcing and business continuity.)",
  },
  {
    id: "KNF_STANOWISKA",
    name: "KNF Stanowiska",
    description:
      "Stanowiska KNF wyrażające poglądy regulatora w kwestiach interpretacyjnych i nadzorczych. (KNF positions expressing the regulator's views on interpretive and supervisory matters.)",
  },
];

const insertSourcebook = db.prepare(
  "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
);

for (const sb of sourcebooks) {
  insertSourcebook.run(sb.id, sb.name, sb.description);
}

console.log(`Inserted ${sourcebooks.length} sourcebooks`);

interface ProvisionRow {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string;
  chapter: string;
  section: string;
}

const provisions: ProvisionRow[] = [
  // ── Rekomendacja D — Zarządzanie ryzykiem IT ────────────────────────────
  {
    sourcebook_id: "KNF_REKOMENDACJE",
    reference: "KNF_REKOMENDACJE D.1.1",
    title: "Strategia w zakresie technologii informacyjnej i bezpieczeństwa środowiska teleinformatycznego",
    text: "Bank powinien posiadać zatwierdzoną przez radę nadzorczą strategię w zakresie technologii informacyjnej i bezpieczeństwa środowiska teleinformatycznego, spójną ze strategią biznesową banku. Strategia powinna uwzględniać cele w zakresie bezpieczeństwa informacji, zarządzania ryzykiem IT oraz ciągłości działania systemów teleinformatycznych.",
    type: "recommendation",
    status: "in_force",
    effective_date: "2013-01-01",
    chapter: "D",
    section: "D.1",
  },
  {
    sourcebook_id: "KNF_REKOMENDACJE",
    reference: "KNF_REKOMENDACJE D.2.1",
    title: "Zarządzanie ryzykiem związanym z technologią informacyjną",
    text: "Bank powinien posiadać formalny proces identyfikacji, oceny, kontroli i monitorowania ryzyka związanego z technologią informacyjną. Proces ten powinien być zintegrowany z ogólnym systemem zarządzania ryzykiem banku i powinien obejmować ryzyka wynikające z systemów informatycznych, danych, infrastruktury oraz usług świadczonych przez podmioty zewnętrzne.",
    type: "recommendation",
    status: "in_force",
    effective_date: "2013-01-01",
    chapter: "D",
    section: "D.2",
  },
  {
    sourcebook_id: "KNF_REKOMENDACJE",
    reference: "KNF_REKOMENDACJE D.3.1",
    title: "Bezpieczeństwo środowiska teleinformatycznego",
    text: "Bank powinien zapewniać bezpieczeństwo środowiska teleinformatycznego poprzez wdrożenie odpowiednich mechanizmów kontrolnych, w tym kontroli dostępu logicznego i fizycznego, szyfrowania danych, monitorowania zdarzeń bezpieczeństwa, zarządzania podatnościami oraz ochrony przed złośliwym oprogramowaniem.",
    type: "recommendation",
    status: "in_force",
    effective_date: "2013-01-01",
    chapter: "D",
    section: "D.3",
  },
  {
    sourcebook_id: "KNF_REKOMENDACJE",
    reference: "KNF_REKOMENDACJE D.4.1",
    title: "Zapewnienie ciągłości działania",
    text: "Bank powinien posiadać plany zapewnienia ciągłości działania w zakresie systemów teleinformatycznych. Plany powinny być regularnie testowane, aktualizowane i zatwierdzane przez zarząd. Testy powinny obejmować scenariusze awarii systemów krytycznych oraz ataki cybernetyczne.",
    type: "recommendation",
    status: "in_force",
    effective_date: "2013-01-01",
    chapter: "D",
    section: "D.4",
  },

  // ── Wytyczne dotyczące outsourcingu ─────────────────────────────────────
  {
    sourcebook_id: "KNF_WYTYCZNE",
    reference: "KNF_WYTYCZNE OUT.1.1",
    title: "Definicja outsourcingu i zakres stosowania wytycznych",
    text: "Niniejsze wytyczne stosuje się do umów outsourcingu zawieranych przez podmioty nadzorowane z dostawcami usług. Outsourcing oznacza powierzenie innemu podmiotowi, w drodze umowy, wykonywania czynności faktycznych lub prawnych związanych z działalnością podmiotu nadzorowanego. Wytyczne mają zastosowanie zarówno do outsourcingu kluczowego, jak i pozostałego.",
    type: "guideline",
    status: "in_force",
    effective_date: "2020-06-01",
    chapter: "OUT",
    section: "OUT.1",
  },
  {
    sourcebook_id: "KNF_WYTYCZNE",
    reference: "KNF_WYTYCZNE OUT.2.1",
    title: "Nadzór nad outsourcingiem kluczowym",
    text: "Podmiot nadzorowany jest zobowiązany do sprawowania efektywnego nadzoru nad outsourcingiem kluczowym. Nadzór powinien obejmować regularne przeglądy umów outsourcingowych, monitorowanie poziomu świadczonych usług oraz ocenę ryzyka. Podmiot nadzorowany powinien zachować zdolność do przejęcia funkcji zleconych na zewnątrz w przypadku awarii dostawcy.",
    type: "guideline",
    status: "in_force",
    effective_date: "2020-06-01",
    chapter: "OUT",
    section: "OUT.2",
  },
  {
    sourcebook_id: "KNF_WYTYCZNE",
    reference: "KNF_WYTYCZNE OUT.3.1",
    title: "Wymogi umowne w outsourcingu",
    text: "Umowy outsourcingowe powinny zawierać co najmniej: precyzyjny opis powierzonych czynności i poziomów usług (SLA), prawo do audytu dostawcy, wymogi w zakresie bezpieczeństwa informacji i ochrony danych, warunki rozwiązania umowy oraz plany wyjścia zapewniające ciągłość działania.",
    type: "guideline",
    status: "in_force",
    effective_date: "2020-06-01",
    chapter: "OUT",
    section: "OUT.3",
  },

  // ── Stanowiska KNF ──────────────────────────────────────────────────────
  {
    sourcebook_id: "KNF_STANOWISKA",
    reference: "KNF_STANOWISKA ST.2021.01",
    title: "Stanowisko KNF w sprawie stosowania chmury obliczeniowej",
    text: "KNF wyraża pozytywne stanowisko wobec korzystania z usług chmury obliczeniowej przez podmioty nadzorowane, pod warunkiem spełnienia wymogów bezpieczeństwa i zarządzania ryzykiem. Podmioty zamierzające korzystać z chmury powinny przeprowadzić analizę ryzyka, zapewnić możliwość audytu dostawcy oraz zagwarantować dostęp KNF do danych i systemów.",
    type: "position",
    status: "in_force",
    effective_date: "2021-04-23",
    chapter: "ST",
    section: "ST.2021",
  },
  {
    sourcebook_id: "KNF_STANOWISKA",
    reference: "KNF_STANOWISKA ST.2023.01",
    title: "Stanowisko KNF w sprawie sztucznej inteligencji w sektorze finansowym",
    text: "KNF oczekuje, że podmioty nadzorowane stosujące rozwiązania oparte na sztucznej inteligencji zapewnią przejrzystość algorytmów podejmujących decyzje kredytowe, wykrywających nadużycia lub oceniających ryzyko. Modele AI powinny być regularnie walidowane, monitorowane pod kątem dyskryminacji oraz podlegać nadzorowi człowieka w procesach o istotnym znaczeniu dla klientów.",
    type: "position",
    status: "in_force",
    effective_date: "2023-09-15",
    chapter: "ST",
    section: "ST.2023",
  },
];

const insertProvision = db.prepare(`
  INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAll = db.transaction(() => {
  for (const p of provisions) {
    insertProvision.run(
      p.sourcebook_id,
      p.reference,
      p.title,
      p.text,
      p.type,
      p.status,
      p.effective_date,
      p.chapter,
      p.section,
    );
  }
});

insertAll();

console.log(`Inserted ${provisions.length} sample provisions`);

interface EnforcementRow {
  firm_name: string;
  reference_number: string;
  action_type: string;
  amount: number;
  date: string;
  summary: string;
  sourcebook_references: string;
}

const enforcements: EnforcementRow[] = [
  {
    firm_name: "Getin Noble Bank S.A.",
    reference_number: "KNF-ENF-2022-001",
    action_type: "fine",
    amount: 22_000_000,
    date: "2022-09-30",
    summary:
      "KNF nałożyła na Getin Noble Bank karę pieniężną w wysokości 22 mln zł za wieloletnie naruszenia wymogów ostrożnościowych, w tym nietworzenie odpowiednich rezerw na ryzyko kredytowe oraz stosowanie niezgodnych z prawem praktyk sprzedażowych. Bank utracił zdolność do samodzielnej naprawy sytuacji i został poddany przymusowej restrukturyzacji.",
    sourcebook_references: "KNF_REKOMENDACJE D.2.1",
  },
  {
    firm_name: "FM Bank PBP S.A.",
    reference_number: "KNF-ENF-2018-002",
    action_type: "restriction",
    amount: 0,
    date: "2018-06-14",
    summary:
      "KNF ograniczyła działalność FM Bank PBP w związku z naruszeniami wymogów kapitałowych i stwierdzeniem poważnych uchybień w zarządzaniu ryzykiem kredytowym. Bank został zobowiązany do wstrzymania udzielania kredytów do czasu przywrócenia wymaganych poziomów kapitału.",
    sourcebook_references: "KNF_WYTYCZNE OUT.2.1",
  },
];

const insertEnforcement = db.prepare(`
  INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertEnforcementsAll = db.transaction(() => {
  for (const e of enforcements) {
    insertEnforcement.run(
      e.firm_name,
      e.reference_number,
      e.action_type,
      e.amount,
      e.date,
      e.summary,
      e.sourcebook_references,
    );
  }
});

insertEnforcementsAll();

console.log(`Inserted ${enforcements.length} sample enforcement actions`);

const provisionCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions").get() as { cnt: number }
).cnt;
const sourcebookCount = (
  db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as { cnt: number }
).cnt;
const enforcementCount = (
  db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as { cnt: number }
).cnt;
const ftsCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as { cnt: number }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Sourcebooks:          ${sourcebookCount}`);
console.log(`  Provisions:           ${provisionCount}`);
console.log(`  Enforcement actions:  ${enforcementCount}`);
console.log(`  FTS entries:          ${ftsCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
