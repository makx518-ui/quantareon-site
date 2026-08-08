#!/usr/bin/env python3
"""Проверки сайта QUANTAREON.

ЗАЧЕМ. Тут не логика, как в остальных проектах, а целостность витрины.
Проверяется ровно то, на чём мы спотыкались вживую 08.08:

  · страница отвалилась, а узнали случайно
  · разметку для соцсетей прописывали руками на двенадцать страниц —
    где-то могло не встать
  · метку версии модуля двигали в двух файлах и путались
  · модуль голоса дважды ломался, и голос замолкал
  · в карте сайта мог остаться мёртвый адрес

Запуск:
    python3 tests/test_site.py                # против живого сайта
    python3 tests/test_site.py --local .      # против файлов в папке

Нужен только Python 3.9+. Ничего ставить не надо.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

САЙТ = "https://quantareon.com"

# двенадцать страниц: шесть пар «английская — русская»
ПАРЫ = [
    ("index.html", "ru.html"),
    ("essay.html", "essay-ru.html"),
    ("architecture.html", "architecture-ru.html"),
    ("labs.html", "labs-ru.html"),
    ("music.html", "music-ru.html"),
    ("video.html", "video-ru.html"),
]
СТРАНИЦЫ = [с for пара in ПАРЫ for с in пара]

СЛУЖЕБНЫЕ = ["sitemap.xml", "robots.txt", "og-image.jpg",
             "manifest.json", "icon-192.png", "icon-512.png"]

АУДИОКНИГА = [f"audio-{я}-{ч}.mp3" for я in ("ru", "en") for ч in (1, 2, 3)]


# ─────────────────────────────────────────────────────────────
#  мелкая самодельная проверялка — чтобы не тянуть зависимости
# ─────────────────────────────────────────────────────────────

class Счёт:
    def __init__(self) -> None:
        self.всего = 0
        self.упало: list[str] = []

    def проверить(self, условие: bool, что: str, подробность: str = "") -> None:
        self.всего += 1
        if условие:
            print(f"  ✅ {что}")
        else:
            хвост = f" — {подробность}" if подробность else ""
            print(f"  ❌ {что}{хвост}")
            self.упало.append(что + хвост)

    def итог(self) -> int:
        print()
        print("─" * 62)
        прошло = self.всего - len(self.упало)
        if not self.упало:
            print(f"🎯 ВСЁ ЧИСТО — {прошло} из {self.всего}")
            return 0
        print(f"⚠️  ПРОВАЛЕНО {len(self.упало)} из {self.всего}")
        for с in self.упало:
            print(f"     · {с}")
        return 1


счёт = Счёт()


# ─────────────────────────────────────────────────────────────
#  откуда берём страницы: с сайта или из папки
# ─────────────────────────────────────────────────────────────

ПАПКА: Path | None = None


def взять(имя: str) -> str | None:
    """Содержимое файла. None — если недоступен."""
    if ПАПКА is not None:
        путь = ПАПКА / имя
        if not путь.exists():
            return None
        try:
            return путь.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return None
    try:
        запрос = urllib.request.Request(
            f"{САЙТ}/{имя}", headers={"User-Agent": "quantareon-selftest"})
        with urllib.request.urlopen(запрос, timeout=25) as ответ:
            return ответ.read().decode("utf-8", errors="replace")
    except Exception:
        return None


def доступен(адрес: str) -> bool:
    """Отвечает ли адрес. Для локального прогона — существует ли файл."""
    if ПАПКА is not None and адрес.startswith(САЙТ):
        return (ПАПКА / адрес[len(САЙТ) + 1:]).exists()
    try:
        запрос = urllib.request.Request(
            адрес, headers={"User-Agent": "quantareon-selftest"}, method="HEAD")
        with urllib.request.urlopen(запрос, timeout=25) as ответ:
            return 200 <= ответ.status < 400
    except urllib.error.HTTPError as e:
        return 200 <= e.code < 400
    except Exception:
        return False


# ─────────────────────────────────────────────────────────────
#  сами проверки
# ─────────────────────────────────────────────────────────────

def страницы_открываются() -> None:
    print("\n📄 СТРАНИЦЫ ОТКРЫВАЮТСЯ")
    for имя in СТРАНИЦЫ:
        счёт.проверить(взять(имя) is not None, имя, "не отдаётся")


def служебные_на_месте() -> None:
    print("\n🔧 СЛУЖЕБНЫЕ ФАЙЛЫ")
    for имя in СЛУЖЕБНЫЕ:
        есть = взять(имя) is not None if имя.endswith((".xml", ".txt", ".json")) \
            else доступен(f"{САЙТ}/{имя}")
        счёт.проверить(есть, имя, "отсутствует")


def аудиокнига_цела() -> None:
    print("\n🎧 АУДИОКНИГА (три части на язык)")
    for имя in АУДИОКНИГА:
        счёт.проверить(доступен(f"{САЙТ}/{имя}"), имя, "не отдаётся")
    # четвёртых частей быть не должно — удалены 08.08
    for имя in ("audio-ru-4.mp3", "audio-en-4.mp3"):
        счёт.проверить(not доступен(f"{САЙТ}/{имя}"),
                       f"{имя} убран", "остался от прежней нарезки")


def разметка_на_каждой_странице() -> None:
    """Открытый граф, canonical и языки — то, что делали руками."""
    print("\n🌐 РАЗМЕТКА ДЛЯ ПОИСКА И СОЦСЕТЕЙ")
    обязательно = [
        ('rel="canonical"', "canonical"),
        ('property="og:title"', "og:title"),
        ('property="og:description"', "og:description"),
        ('property="og:image"', "og:image"),
        ('property="og:url"', "og:url"),
        ('name="twitter:card"', "twitter:card"),
    ]
    for имя in СТРАНИЦЫ:
        s = взять(имя)
        if s is None:
            счёт.проверить(False, f"{имя}: разметка", "страница недоступна")
            continue
        нет = [подпись for метка, подпись in обязательно if метка not in s]
        счёт.проверить(not нет, f"{имя}: полная разметка",
                       "не хватает: " + ", ".join(нет) if нет else "")
        счёт.проверить(s.count("hreflang=") == 3, f"{имя}: три языковые связки",
                       f"найдено {s.count('hreflang=')}")


def описания_свои_а_не_чужие() -> None:
    """У каждой страницы должно быть своё описание, не копия соседней."""
    print("\n✍️  ОПИСАНИЯ НЕ ПОВТОРЯЮТСЯ")
    описания: dict[str, list[str]] = {}
    for имя in СТРАНИЦЫ:
        s = взять(имя)
        if s is None:
            continue
        m = re.search(r'name="description"\s+content="([^"]*)"', s)
        if m:
            описания.setdefault(m.group(1)[:120], []).append(имя)
    for текст, где in описания.items():
        # главная и эссе делят описание намеренно — это одна и та же вещь
        разрешено = {"index.html", "essay.html"}, {"ru.html", "essay-ru.html"}
        если_можно = any(set(где) <= пара for пара in разрешено)
        счёт.проверить(len(где) == 1 or если_можно,
                       f"описание уникально: {где[0]}",
                       "то же самое на: " + ", ".join(где[1:]) if len(где) > 1 else "")


def карта_сайта_честная() -> None:
    print("\n🗺️  КАРТА САЙТА")
    сырое = взять("sitemap.xml")
    if сырое is None:
        счёт.проверить(False, "sitemap.xml читается", "не отдаётся")
        return
    try:
        корень = ET.fromstring(сырое)
    except ET.ParseError as e:
        счёт.проверить(False, "sitemap.xml разбирается", str(e))
        return
    счёт.проверить(True, "sitemap.xml разбирается")

    NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
    адреса = [e.text.strip() for e in корень.iter(NS + "loc") if e.text]
    счёт.проверить(len(адреса) >= len(СТРАНИЦЫ),
                   f"в карте {len(адреса)} адресов",
                   f"страниц {len(СТРАНИЦЫ)}, а в карте меньше")
    for адрес in адреса:
        счёт.проверить(доступен(адрес), f"живой адрес: {адрес.split('/')[-1] or '/'}",
                       "мёртвая ссылка в карте")


def robots_указывает_на_карту() -> None:
    print("\n🤖 ROBOTS.TXT")
    s = взять("robots.txt")
    if s is None:
        счёт.проверить(False, "robots.txt читается", "не отдаётся")
        return
    счёт.проверить("Sitemap:" in s, "указывает на карту сайта")
    счёт.проверить("Allow: /" in s or "Disallow:" in s, "есть правила обхода")


def метка_версии_совпадает() -> None:
    """Одно и то же число в обеих главных — иначе телефон возьмёт старый файл."""
    print("\n🏷️  МЕТКА ВЕРСИИ ГОЛОСОВОГО МОДУЛЯ")
    версии: dict[str, str] = {}
    for имя in ("index.html", "ru.html"):
        s = взять(имя)
        if s is None:
            continue
        m = re.search(r"quantareon-voice\.js\?v=(\d+)", s)
        if m:
            версии[имя] = m.group(1)
    счёт.проверить(len(версии) == 2, "метка есть в обеих главных",
                   f"нашлось: {list(версии)}")
    if len(версии) == 2:
        значения = set(версии.values())
        счёт.проверить(len(значения) == 1,
                       f"метки совпадают (v={list(значения)[0] if len(значения)==1 else '?'})",
                       f"разные: {версии}")


def модуль_голоса_цел() -> None:
    """Грубая, но надёжная проверка: скобки сходятся и ключевое на месте."""
    print("\n🎙️  МОДУЛЬ ГОЛОСА")
    s = взять("quantareon-voice.js")
    if s is None:
        счёт.проверить(False, "quantareon-voice.js читается", "не отдаётся")
        return
    счёт.проверить(s.count("{") == s.count("}"), "фигурные скобки сходятся",
                   f"{{ = {s.count('{')}, }} = {s.count('}')}")
    счёт.проверить(s.count("(") == s.count(")"), "круглые скобки сходятся")
    for кусок, подпись in [
        ("MicVAD", "определение речи"),
        ("WebSocket", "связь с сервером"),
        ("VAD_REDEMPTION_FRAMES", "настройка детектора речи"),
        ("function bargeIn", "перебивание"),
        ("QuantareonVoice", "модуль публикуется наружу"),
    ]:
        счёт.проверить(кусок in s, f"на месте: {подпись}")


def ссылки_в_меню_не_битые() -> None:
    print("\n🔗 ССЫЛКИ ВНУТРИ САЙТА")
    свои: set[str] = set()
    for имя in СТРАНИЦЫ:
        s = взять(имя)
        if s is None:
            continue
        for ссылка in re.findall(r'href="([^"#?:]+\.html)"', s):
            свои.add(ссылка.lstrip("./"))
    счёт.проверить(bool(свои), "ссылки найдены")
    for ссылка in sorted(свои):
        счёт.проверить(взять(ссылка) is not None, f"ведёт куда надо: {ссылка}",
                       "битая ссылка")


def главная_отдаётся_с_корня() -> None:
    print("\n🏠 КОРЕНЬ САЙТА")
    if ПАПКА is not None:
        счёт.проверить((ПАПКА / "index.html").exists(), "index.html в корне")
        return
    счёт.проверить(доступен(САЙТ + "/"), "quantareon.com открывается")


def main() -> int:
    global ПАПКА
    р = argparse.ArgumentParser(description="Проверки сайта QUANTAREON")
    р.add_argument("--local", metavar="ПАПКА",
                   help="проверять файлы в папке, а не живой сайт")
    а = р.parse_args()
    if а.local:
        ПАПКА = Path(а.local)
        if not ПАПКА.exists():
            print(f"нет такой папки: {ПАПКА}")
            return 2
        print(f"🔍 Проверяю файлы в {ПАПКА.resolve()}")
    else:
        print(f"🔍 Проверяю живой сайт {САЙТ}")

    главная_отдаётся_с_корня()
    страницы_открываются()
    служебные_на_месте()
    ссылки_в_меню_не_битые()
    разметка_на_каждой_странице()
    описания_свои_а_не_чужие()
    карта_сайта_честная()
    robots_указывает_на_карту()
    метка_версии_совпадает()
    модуль_голоса_цел()
    if ПАПКА is None:
        аудиокнига_цела()

    return счёт.итог()


if __name__ == "__main__":
    sys.exit(main())
