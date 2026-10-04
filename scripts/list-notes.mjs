// Prints every content note with project, type, title, id and opening line. Used to craft eval questions.
import Database from "better-sqlite3";
const db = new Database("data/index.db", { readonly: true });
const rows = db
  .prepare("select id,title,type,project,substr(body,1,260) b from notes where type not in ('hub','concept','moc','meta','guide') order by project,title")
  .all();
for (const r of rows) {
  const b = r.b.replace(/\s+/g, " ").replace(/^#\s+[^#]*?(?=\s[A-Z])/, "").slice(0, 200);
  console.log(`${r.project}|${r.type}|${r.title}|${r.id}\n    ${b}`);
}
