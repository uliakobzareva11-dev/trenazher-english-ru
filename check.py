#!/usr/bin/env python3
"""Проверка тренажёра перед публикацией и после неё.

  python3 check.py              перед коммитом: сравнить index.html с последней версией в git
  python3 check.py --live       после публикации: на сайте лежит ровно тот файл, что у тебя
  python3 check.py --force "причина"   пропустить стоп, если тему убрала намеренно

Что проверяет перед коммитом:
  · файл целый, JavaScript без ошибок
  · ни одна тема не пропала из меню и у каждой темы есть содержимое
  · ни одна тема не похудела больше чем на 15 %, файл — больше чем на 10 %
  · ключи хранения прогресса не сменились (иначе у учеников обнулится прогресс)
  · задания не противоречат сами себе: верный ответ не стоит среди неверных,
    число пропусков ___ равно числу ответов, вопрос не повторяется, есть объяснение
  · сколько заданий без источника (поле src)

Код выхода 0 — можно публиковать, 1 — стоп, читать сообщения.
Только стандартная библиотека Python, ставить ничего не нужно.
"""
import collections, hashlib, json, re, shutil, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

FILE = Path(__file__).with_name("index.html")
SITE = "https://trenazher-english.ru/"
SHRINK_FILE = 0.10   # файл похудел больше чем на 10 % — стоп
SHRINK_TOPIC = 0.15  # тема похудела больше чем на 15 % — стоп

stops, notes = [], []


def menu_ids(s):
    m = re.search(r"const MENU\s*=\s*\[(.*?)\];", s, re.S)
    if not m:
        return None
    return re.findall(r'"([a-z][a-z0-9_]*)"', m.group(1))


def store_keys(s):
    return dict(re.findall(r'\b([A-Z_]*KEY)\s*=\s*"([^"]+)"', s))


def topic_sizes(s):
    """Размер каждой темы в SETS: от «id: { kind:» до начала следующей темы."""
    starts = [(m.group(1), m.start()) for m in re.finditer(r'^\s*([a-z][a-z0-9_]*):\s*\{\s*kind\s*:', s, re.M)]
    tail = s.find("</script>", starts[-1][1]) if starts else -1
    sizes = {}
    for i, (tid, pos) in enumerate(starts):
        end = starts[i + 1][1] if i + 1 < len(starts) else (tail if tail > 0 else len(s))
        sizes[tid] = end - pos
    return sizes


def exercises(s):
    """Все задания вида {"q": …, "a": …, "wrong": […], "why": …}."""
    out, broken = [], 0
    for raw in re.findall(r'\{"q":.*?\}(?=\s*[,\]\n])', s):
        try:
            out.append(json.loads(raw))
        except ValueError:
            broken += 1
    return out, broken


def check_exercises(s):
    items, broken = exercises(s)
    if broken:
        stops.append("%d заданий не читаются (сломаны кавычки или скобки)" % broken)
    norm = lambda x: re.sub(r"\s+", " ", str(x)).strip().lower()
    count = collections.Counter(norm(e.get("q", "")) for e in items)
    problems = collections.defaultdict(list)
    for e in items:
        q, a = e.get("q", ""), e.get("a", "")
        answers = [a] + ([e["a2"]] if e.get("a2") else [])
        wrong = [norm(w) for w in (e.get("wrong") or [])]
        alts = [norm(x) for x in (e.get("alt") or [])]
        short = q[:70]
        if not a:
            problems["нет верного ответа"].append(short)
        if not e.get("why"):
            problems["нет объяснения"].append(short)
        if norm(a) in wrong or any(x in wrong for x in alts):
            problems["верный ответ стоит среди неверных"].append(short)
        if len(set(wrong)) < len(wrong):
            problems["неверный вариант повторяется"].append(short)
        if "___" in q and q.count("___") != len(answers):
            problems["пропусков ___ %d, а ответов %d" % (q.count("___"), len(answers))].append(short)
        if count[norm(q)] > 1:
            problems["вопрос повторяется"].append(short)
    for what, qs in problems.items():
        stops.append("%s — %d: %s" % (what, len(qs), " | ".join(sorted(set(qs))[:3])))
    no_src = sum(1 for e in items if not e.get("src"))
    notes.append("заданий %d, без источника (src) %d" % (len(items), no_src))
    return len(items), no_src


def previous_version():
    try:
        out = subprocess.run(["git", "show", "HEAD:index.html"], cwd=FILE.parent,
                             capture_output=True, check=True)
        return out.stdout.decode("utf-8")
    except Exception:
        return None


def check_js(s):
    node = shutil.which("node")
    if not node:
        notes.append("node не установлен — JavaScript не проверен, открой страницу в браузере")
        return
    for i, code in enumerate(re.findall(r"<script[^>]*>(.*?)</script>", s, re.S)):
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
            f.write(code)
        r = subprocess.run([node, "--check", f.name], capture_output=True, text=True)
        Path(f.name).unlink()
        if r.returncode:
            lines = r.stderr.splitlines()
            err = next((l for l in lines if "Error" in l), lines[-1] if lines else "?")
            m = next((re.search(r"\.js:(\d+)", l) for l in lines if re.search(r"\.js:\d+", l)), None)
            where = "(строка %s скрипта)" % m.group(1) if m else ""
            stops.append("ошибка в JavaScript: %s %s" % (err.strip(), where))


def before_commit(force):
    if not FILE.exists() or FILE.stat().st_size == 0:
        stops.append("index.html нет или он пустой")
        return
    s = FILE.read_text(encoding="utf-8")
    if "</html>" not in s:
        stops.append("файл обрывается: нет </html> в конце — похоже, запись не дописалась")
    check_js(s)

    ids = menu_ids(s)
    sizes = topic_sizes(s)
    if ids is None:
        stops.append("не нашла const MENU — меню тем сломано или переименовано")
        ids = []
    for tid in ids:
        if tid not in sizes:
            stops.append("тема «%s» есть в меню, но её содержимого в SETS нет" % tid)
    hidden = [t for t in sizes if t not in ids]
    if hidden:
        notes.append("темы в SETS, которых нет в меню (ученик их не увидит): " + ", ".join(hidden))

    n_items, n_nosrc = check_exercises(s)

    old = previous_version()
    if old is None:
        notes.append("прошлой версии в git нет — сравнивать не с чем, это первая публикация")
    else:
        old_ids, old_sizes, old_keys = menu_ids(old) or [], topic_sizes(old), store_keys(old)
        old_items, _ = exercises(old)

        lost = [t for t in old_ids if t not in ids]
        if lost:
            stops.append("из меню пропали темы: " + ", ".join(lost))
        added = [t for t in ids if t not in old_ids]
        if added:
            notes.append("новые темы в меню: " + ", ".join(added))

        for tid, old_len in old_sizes.items():
            new_len = sizes.get(tid)
            if new_len and new_len < old_len * (1 - SHRINK_TOPIC):
                stops.append("тема «%s» похудела на %d %% (%d → %d знаков) — проверь, не потерялись ли задания"
                             % (tid, round((1 - new_len / old_len) * 100), old_len, new_len))

        if n_items < len(old_items):
            stops.append("заданий стало меньше: было %d, стало %d" % (len(old_items), n_items))
        elif n_items > len(old_items):
            notes.append("новых заданий: %d" % (n_items - len(old_items)))

        if len(s) < len(old) * (1 - SHRINK_FILE):
            stops.append("файл похудел на %d %% (%d → %d знаков)"
                         % (round((1 - len(s) / len(old)) * 100), len(old), len(s)))

        keys = store_keys(s)
        for name, val in old_keys.items():
            if name not in keys:
                stops.append("пропал ключ хранения %s — у учеников пропадёт прогресс" % name)
            elif keys[name] != val:
                if ('"%s"' % val) in s:
                    notes.append("ключ %s сменился %s → %s, старый ещё читается (перенос прогресса есть)"
                                 % (name, val, keys[name]))
                else:
                    stops.append("ключ %s сменился %s → %s, а старый нигде не читается — "
                                 "у всех учеников обнулится прогресс" % (name, val, keys[name]))

    if stops and force:
        notes.append("стопы пропущены намеренно: " + force)
        stops.clear()


def fetch(url):
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return r.read()
    except Exception:
        out = subprocess.run(["curl", "-s", "--max-time", "20", url], capture_output=True)
        return out.stdout if out.returncode == 0 and out.stdout else None


def live():
    local = FILE.read_bytes()
    body = fetch("%s?v=%d" % (SITE, int(time.time())))
    if body is None:
        stops.append("сайт не открылся")
        return
    if hashlib.md5(body).hexdigest() == hashlib.md5(local).hexdigest():
        notes.append("на сайте ровно твой файл (%d байт)" % len(local))
    else:
        stops.append("на сайте другая версия (%d байт против %d у тебя). GitHub обновляет до 10 минут — "
                     "подожди и повтори. Через 15 минут то же самое — значит, изменения не отправлены (git push)"
                     % (len(body), len(local)))


if __name__ == "__main__":
    args = sys.argv[1:]
    force = ""
    if "--force" in args:
        i = args.index("--force")
        force = args[i + 1] if i + 1 < len(args) else "без причины"
    live() if "--live" in args else before_commit(force)
    for n in notes:
        print("·", n)
    for s in stops:
        print("⛔", s)
    print("⛔ СТОП — не публикуем" if stops else "✅ можно")
    sys.exit(1 if stops else 0)
