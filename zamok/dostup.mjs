// Платный доступ к тренажёру по личным ссылкам.
//
//   node zamok/dostup.mjs dobavit "Маша Петрова" 2026-11-22 400   новый ученик, оплачено до даты, сумма (своим — без суммы)
//   node zamok/dostup.mjs prodlit "Маша Петрова" 2026-12-22 400   продлить (ссылка та же)
//   node zamok/dostup.mjs spisok                              кто есть и до какого числа
//   node zamok/dostup.mjs sobrat                              собрать закрытую версию сайта для публикации
//   node zamok/dostup.mjs vylozhit                            собрать и выложить на сайт (репо trenazher-english-site)
//   node zamok/dostup.mjs srok                               у кого доступ кончился или кончится за 3 дня — в начале каждой работы
//
// Как устроено. На сайте лежит открытая версия (чтение и звуки + одна тема ЕГЭ, см. OTKRYTO),
// а полный index.html зашифрован в polny.txt ключом, который при каждой сборке новый.
// Этот ключ упакован отдельно под код каждого ученика с действующей оплатой.
// Кто не продлил — при следующей сборке его упаковки нет, ссылка перестаёт открывать тренажёр.
// У остальных ссылки не меняются.
//
// Список учеников — данные детей, поэтому он лежит ВНЕ git: ../trenazher-dostup/ucheniki.json
import { webcrypto as crypto } from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOSTUP = path.resolve(REPO, "..", "trenazher-dostup");
const SPISOK = path.join(DOSTUP, "ucheniki.json");
const SAIT = path.join(DOSTUP, "sait");
const SBORKA = path.join(DOSTUP, "poslednyaya-sborka.json"); // кого впустила последняя сборка — для srok
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

// Что видно без ссылки (решение Юли 28.10): чтение и звуки целиком + первая тема «Грамматики в формате ЕГЭ».
// У остальных тем остаются только названия и число заданий: самих заданий, ответов и правил в открытой версии нет.
const OTKRYTO = { types: "vse", diph: "vse", cons: "vse", ege: "vse", endings: "vse", texts: "vse", egegram: [0] };

function otkrytayaVersiya(html) {
  const vynut = name => {
    const s = html.indexOf("const " + name + " = {");
    const e = html.indexOf("\n};", s);
    if (s < 0 || e < 0) throw new Error(name + " не найден в index.html");
    return { s, e, obj: Function("return (" + html.slice(s + ("const " + name + " = ").length, e + 2) + ")")() };
  };
  const SETS = vynut("SETS"), REVISE = vynut("REVISE");
  for (const [k, set] of Object.entries(SETS.obj)) {
    const ok = OTKRYTO[k];
    set.blocks = set.blocks.map((b, i) => (ok === "vse" || (ok && ok.includes(i))) ? b
      : { name: b.name, zakryto: true, n: (b.drill || []).length, drill: [], explain: [], examples: [] });
    if (set.blocks.every(b => b.zakryto)) set.zakryto = true;
  }
  const revise = Object.fromEntries(Object.entries(REVISE.obj).filter(([k]) => OTKRYTO[k.split("|")[0]] === "vse"));
  // в index.html SETS стоит раньше REVISE — склеиваем куски по порядку
  return html.slice(0, SETS.s) + "const SETS = " + JSON.stringify(SETS.obj) + ";" +
    html.slice(SETS.e + 3, REVISE.s) + "const REVISE = " + JSON.stringify(revise) + ";" + html.slice(REVISE.e + 3);
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

  const sb = b64(crypto.getRandomValues(new Uint8Array(6))).replace(/[^a-z0-9]/gi, "");   // свежий polny.txt мимо кэша
  const shablon = fs.readFileSync(path.join(REPO, "zamok", "obolochka.html"), "utf8");
  const dannye = JSON.stringify({ it: ITER, v: vhody, m: METRIKA, sb });
  const otkryto = JSON.stringify(otkrytayaVersiya(html)).replace(/<\//g, "<\\/");   // </script> внутри строки закрыл бы оболочку
  const out = shablon
    .replace("/*DANNYE*/null", () => dannye)
    .replace("/*OTKRYTO*/\"\"", () => otkryto);
  if (out.includes("/*DANNYE*/") || out.includes("/*OTKRYTO*/")) throw new Error("шаблон оболочки не подставился");

  fs.mkdirSync(SAIT, { recursive: true });
  fs.writeFileSync(path.join(SAIT, "index.html"), out, "utf8");
  fs.writeFileSync(path.join(SAIT, "polny.txt"), JSON.stringify({ iv: b64(iv), s: b64(shifr) }), "utf8");
  fs.writeFileSync(SBORKA, JSON.stringify({ data: segodnya(), imena: dey.map(u => u.imya) }, null, 2) + "\n", "utf8");
  for (const f of ["CNAME", ".nojekyll"]) fs.copyFileSync(path.join(REPO, f), path.join(SAIT, f));
  console.log("собрано: %s (открытая версия %d КБ, полная зашифрована в polny.txt), полную открывают %d из %d учеников",
    path.join(SAIT, "index.html"), Math.round(out.length / 1024), dey.length, d.ucheniki.length);
  const ne = d.ucheniki.filter(u => u.do < segodnya());
  if (ne.length) console.log("доступ закрыт (оплата кончилась): " + ne.map(u => `${u.imya} (до ${u.do})`).join(", "));
}

// Самозанятость: каждая оплата — чек в «Мой налог» сразу при получении денег (npd.nalog.ru).
// Журнал оплат в ucheniki.json — чтобы сверить с чеками в конце месяца.
function oplata(u, summa, data) {
  if (!summa) return;                      // своим бесплатно — чек не нужен
  (u.oplaty ||= []).push({ poluchena: segodnya(), summa: Number(summa), do: data });
  const [g, m, dd] = data.split("-");
  console.log(`\n🧾 ЧЕК в «Мой налог» сегодня: «Доступ к онлайн-тренажёру английского языка до ${dd}.${m}.${g}», ` +
    `${summa} ₽, покупатель — физическое лицо`);
}

const [cmd, imya, data, summa] = process.argv.slice(2);
try {
  if (cmd === "dobavit") {
    proverDatu(data);
    const d = chitat();
    if (d.ucheniki.some(u => u.imya === imya)) throw new Error(`«${imya}» уже есть — используй prodlit`);
    const kod = novyKod();
    const u = { imya, kod, do: data, dobavlen: segodnya(), metka: await metka(kod) };
    d.ucheniki.push(u);
    oplata(u, summa, data);
    zapisat(d);
    console.log(`${imya}: оплачено до ${data}\nссылка: ${ssylka(kod)}\nметка в Метрике: ${await metka(kod)}`);
    console.log("ссылка заработает после «sobrat» и публикации");
  } else if (cmd === "prodlit") {
    proverDatu(data);
    const d = chitat();
    const u = d.ucheniki.find(u => u.imya === imya);
    if (!u) throw new Error(`«${imya}» нет в списке`);
    u.do = data;
    oplata(u, summa, data);
    zapisat(d);
    console.log(`${imya}: продлено до ${data}, ссылка прежняя: ${ssylka(u.kod)}`);
  } else if (cmd === "spisok") {
    for (const u of chitat().ucheniki)
      console.log(`${u.do >= segodnya() ? "✅" : "⛔"} ${u.imya} — до ${u.do} — метка ${u.metka} — ${ssylka(u.kod)}`);
  } else if (cmd === "srok") {
    // Сайт сам сроки не проверяет: истёкший ученик открывает тренажёр, пока сайт не пересобран
    const d = chitat(), s = segodnya();
    const cherez3 = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    const vSborke = fs.existsSync(SBORKA) ? JSON.parse(fs.readFileSync(SBORKA, "utf8")).imena : [];
    const istek = d.ucheniki.filter(u => u.do < s);
    const skoro = d.ucheniki.filter(u => u.do >= s && u.do <= cherez3);
    const pereSobrat = istek.filter(u => vSborke.includes(u.imya));
    for (const u of pereSobrat) console.log(`⛔ ${u.imya}: оплачено до ${u.do}, но на сайте ещё открывает — пересобрать и выложить`);
    for (const u of istek.filter(u => !vSborke.includes(u.imya))) console.log(`· ${u.imya}: доступ закрыт с ${u.do}`);
    for (const u of skoro) console.log(`⏰ ${u.imya}: доступ кончается ${u.do}`);
    if (!pereSobrat.length && !skoro.length) console.log("✅ сроки в порядке: никто не истёк и никому не кончается в ближайшие 3 дня");
  } else if (cmd === "vylozhit") {
    // Сайтовый репо хранит только сборку: каждая публикация — один коммит вместо прошлого (force здесь допустим,
    // это не исходник). Иначе в истории копились бы старые сборки с ключами учеников, которые уже не платят.
    await sobrat();
    const git = (...a) => execFileSync("git", a, { cwd: SAIT, stdio: "pipe" }).toString();
    git("checkout", "-q", "--orphan", "novaya");
    git("add", "-A", "index.html", "polny.txt", "CNAME", ".nojekyll");
    git("-c", "user.name=uliakobzareva11-dev", "-c", "user.email=uliakobzareva11-dev@users.noreply.github.com",
        "commit", "-q", "-m", "Сборка " + segodnya());
    git("branch", "-M", "main");
    git("push", "-q", "--force", "origin", "main");
    console.log("выложено; через 1–10 минут проверить: python3 check.py --live");
  } else if (cmd === "sobrat") {
    await sobrat();
  } else {
    console.log("команды: dobavit «имя» ГГГГ-ММ-ДД [сумма] · prodlit «имя» ГГГГ-ММ-ДД [сумма] · spisok · srok · sobrat · vylozhit");
  }
} catch (e) {
  console.error("⛔ " + e.message);
  process.exit(1);
}
