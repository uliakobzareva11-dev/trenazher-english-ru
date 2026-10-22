// Платный доступ к тренажёру по личным ссылкам.
//
//   node zamok/dostup.mjs dobavit "Маша Петрова" 2026-11-22   новый ученик, оплачено до даты → печатает его ссылку
//   node zamok/dostup.mjs prodlit "Маша Петрова" 2026-12-22   продлить (ссылка та же)
//   node zamok/dostup.mjs spisok                              кто есть и до какого числа
//   node zamok/dostup.mjs sobrat                              собрать закрытую версию сайта для публикации
//
// Как устроено. Весь index.html шифруется ключом, который при каждой сборке новый.
// Этот ключ упакован отдельно под код каждого ученика с действующей оплатой.
// Кто не продлил — при следующей сборке его упаковки нет, ссылка перестаёт открывать тренажёр.
// У остальных ссылки не меняются.
//
// Список учеников — данные детей, поэтому он лежит ВНЕ git: ../trenazher-dostup/ucheniki.json
import { webcrypto as crypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOSTUP = path.resolve(REPO, "..", "trenazher-dostup");
const SPISOK = path.join(DOSTUP, "ucheniki.json");
const SAIT = path.join(DOSTUP, "sait");
const SITE = "https://trenazher-english.ru/";
const METRIKA = 113733723;
const ITER = 150000;                     // PBKDF2: подбирать код перебором долго, телефону — доля секунды
const ABC = "abcdefghjkmnpqrstuvwxyz23456789"; // без 0/o, 1/l/i — чтобы код можно было продиктовать

const enc = new TextEncoder();
const b64 = buf => Buffer.from(buf).toString("base64");
const segodnya = () => new Date().toISOString().slice(0, 10);

function chitat() {
  if (!fs.existsSync(SPISOK)) return { ucheniki: [] };
  return JSON.parse(fs.readFileSync(SPISOK, "utf8"));
}
function zapisat(d) {
  fs.mkdirSync(DOSTUP, { recursive: true });
  fs.writeFileSync(SPISOK, JSON.stringify(d, null, 2) + "\n", "utf8");
}
function novyKod() {
  const r = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(r, x => ABC[x % ABC.length]).join("");
}
async function metka(kod) {            // короткая метка ученика для Метрики — без имени
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("metka:" + kod)));
  return Array.from(h.slice(0, 4), x => x.toString(16).padStart(2, "0")).join("");
}
async function id(kod) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("id:" + kod)));
  return Array.from(h.slice(0, 8), x => x.toString(16).padStart(2, "0")).join("");
}
const ssylka = kod => SITE + "#" + kod;
function proverDatu(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || "")) throw new Error("дата в виде 2026-11-22");
}

async function sobrat() {
  const d = chitat();
  const dey = d.ucheniki.filter(u => u.do >= segodnya());
  if (!dey.length) throw new Error("нет ни одного ученика с действующей оплатой — сайт никто не откроет");
  const html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");

  const kluch = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const syroy = await crypto.subtle.exportKey("raw", kluch);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const shifr = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kluch, enc.encode(html));

  const vhody = {};
  for (const u of dey) {
    const sol = crypto.getRandomValues(new Uint8Array(16));
    const base = await crypto.subtle.importKey("raw", enc.encode(u.kod), "PBKDF2", false, ["deriveKey"]);
    const kk = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: sol, iterations: ITER, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const iv2 = crypto.getRandomValues(new Uint8Array(12));
    const upak = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv2 }, kk, syroy);
    vhody[await id(u.kod)] = [b64(sol), b64(iv2), b64(upak)];
  }

  const shablon = fs.readFileSync(path.join(REPO, "zamok", "obolochka.html"), "utf8");
  const dannye = JSON.stringify({ it: ITER, iv: b64(iv), v: vhody, m: METRIKA });
  const out = shablon
    .replace("/*DANNYE*/null", () => dannye)
    .replace("/*SHIFR*/\"\"", () => JSON.stringify(b64(shifr)));
  if (out.includes("/*DANNYE*/") || out.includes("/*SHIFR*/")) throw new Error("шаблон оболочки не подставился");

  fs.mkdirSync(SAIT, { recursive: true });
  fs.writeFileSync(path.join(SAIT, "index.html"), out, "utf8");
  for (const f of ["CNAME", ".nojekyll"]) fs.copyFileSync(path.join(REPO, f), path.join(SAIT, f));
  console.log("собрано: %s (%d КБ), открывают %d из %d учеников",
    path.join(SAIT, "index.html"), Math.round(out.length / 1024), dey.length, d.ucheniki.length);
  const ne = d.ucheniki.filter(u => u.do < segodnya());
  if (ne.length) console.log("доступ закрыт (оплата кончилась): " + ne.map(u => `${u.imya} (до ${u.do})`).join(", "));
}

const [cmd, imya, data] = process.argv.slice(2);
try {
  if (cmd === "dobavit") {
    proverDatu(data);
    const d = chitat();
    if (d.ucheniki.some(u => u.imya === imya)) throw new Error(`«${imya}» уже есть — используй prodlit`);
    const kod = novyKod();
    d.ucheniki.push({ imya, kod, do: data, dobavlen: segodnya(), metka: await metka(kod) });
    zapisat(d);
    console.log(`${imya}: оплачено до ${data}\nссылка: ${ssylka(kod)}\nметка в Метрике: ${await metka(kod)}`);
    console.log("ссылка заработает после «sobrat» и публикации");
  } else if (cmd === "prodlit") {
    proverDatu(data);
    const d = chitat();
    const u = d.ucheniki.find(u => u.imya === imya);
    if (!u) throw new Error(`«${imya}» нет в списке`);
    u.do = data;
    zapisat(d);
    console.log(`${imya}: продлено до ${data}, ссылка прежняя: ${ssylka(u.kod)}`);
  } else if (cmd === "spisok") {
    for (const u of chitat().ucheniki)
      console.log(`${u.do >= segodnya() ? "✅" : "⛔"} ${u.imya} — до ${u.do} — метка ${u.metka} — ${ssylka(u.kod)}`);
  } else if (cmd === "sobrat") {
    await sobrat();
  } else {
    console.log("команды: dobavit «имя» ГГГГ-ММ-ДД · prodlit «имя» ГГГГ-ММ-ДД · spisok · sobrat");
  }
} catch (e) {
  console.error("⛔ " + e.message);
  process.exit(1);
}
