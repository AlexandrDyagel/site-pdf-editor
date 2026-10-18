"""
Скачивание и подготовка встроенных шрифтов для PDF-редактора.

Почему Python: часть семейств в репозитории Google Fonts лежит только
вариативными файлами (`Manrope[wght].ttf` и подобные). Если встроить такой файл
как есть, fontkit возьмёт экземпляр по умолчанию (например, Montserrat Thin) —
получился бы неверный вес. Поэтому вариативные файлы «закрепляются» на нужном
весе через fontTools (varLib.instancer), и в public/fonts кладутся статические
TTF с полным покрытием (включая кириллицу).

Запуск (пути и имена — в таблице FAMILIES ниже):
    python scripts/tools/prepare-bundled-fonts.py --out public/fonts --report .tmp/fonts-report.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

REPO = "https://raw.githubusercontent.com/google/fonts/main"

# id, имя, лицензия, список начертаний: (ключ, файл-источник, вес или None для статики)
FAMILIES = [
    {
        "id": "tinos",
        "name": "Tinos",
        "license": "OFL 1.1 (Chrome OS metric fonts)",
        "faces": {
            "400-normal": ("ofl/tinos/Tinos-Regular.ttf", None),
            "700-normal": ("ofl/tinos/Tinos-Bold.ttf", None),
            "400-italic": ("ofl/tinos/Tinos-Italic.ttf", None),
        },
    },
    {
        "id": "manrope",
        "name": "Manrope",
        "license": "OFL 1.1 (Mikhail Sharanda)",
        "faces": {
            "400-normal": ("ofl/manrope/Manrope[wght].ttf", 400),
            "700-normal": ("ofl/manrope/Manrope[wght].ttf", 700),
        },
    },
    {
        "id": "rubik",
        "name": "Rubik",
        "license": "OFL 1.1 (Hubert & Fischer)",
        "faces": {
            "400-normal": ("ofl/rubik/Rubik[wght].ttf", 400),
            "700-normal": ("ofl/rubik/Rubik[wght].ttf", 700),
            "400-italic": ("ofl/rubik/Rubik-Italic[wght].ttf", 400),
        },
    },
    {
        "id": "ibm-plex-sans",
        "name": "IBM Plex Sans",
        "license": "OFL 1.1 (IBM)",
        "faces": {
            "400-normal": ("ofl/ibmplexsans/IBMPlexSans[wdth,wght].ttf", 400),
            "700-normal": ("ofl/ibmplexsans/IBMPlexSans[wdth,wght].ttf", 700),
            "400-italic": ("ofl/ibmplexsans/IBMPlexSans-Italic[wdth,wght].ttf", 400),
        },
    },
    {
        "id": "cormorant",
        "name": "Cormorant",
        "license": "OFL 1.1 (Christian Thalmann)",
        "faces": {
            "400-normal": ("ofl/cormorant/Cormorant[wght].ttf", 400),
            "700-normal": ("ofl/cormorant/Cormorant[wght].ttf", 700),
            "400-italic": ("ofl/cormorant/Cormorant-Italic[wght].ttf", 400),
        },
    },
    {
        "id": "merriweather",
        "name": "Merriweather",
        "license": "OFL 1.1 (Sorkin Type)",
        "faces": {
            "400-normal": ("ofl/merriweather/Merriweather[opsz,wdth,wght].ttf", 400),
            "700-normal": ("ofl/merriweather/Merriweather[opsz,wdth,wght].ttf", 700),
            "400-italic": ("ofl/merriweather/Merriweather-Italic[opsz,wdth,wght].ttf", 400),
        },
    },
    {
        "id": "pt-serif",
        "name": "PT Serif",
        "license": "OFL 1.1 (ParaType)",
        "faces": {
            "400-normal": ("ofl/ptserif/PT_Serif-Web-Regular.ttf", None),
            "700-normal": ("ofl/ptserif/PT_Serif-Web-Bold.ttf", None),
            "400-italic": ("ofl/ptserif/PT_Serif-Web-Italic.ttf", None),
        },
    },
    {
        "id": "montserrat",
        "name": "Montserrat",
        "license": "OFL 1.1 (Julieta Ulanovsky)",
        "faces": {
            "400-normal": ("ofl/montserrat/Montserrat[wght].ttf", 400),
            "700-normal": ("ofl/montserrat/Montserrat[wght].ttf", 700),
            "400-italic": ("ofl/montserrat/Montserrat-Italic[wght].ttf", 400),
        },
    },
    {
        "id": "raleway",
        "name": "Raleway",
        "license": "OFL 1.1 (Matt McInerney)",
        "faces": {
            "400-normal": ("ofl/raleway/Raleway[wght].ttf", 400),
            "700-normal": ("ofl/raleway/Raleway[wght].ttf", 700),
            "400-italic": ("ofl/raleway/Raleway-Italic[wght].ttf", 400),
        },
    },
    {
        "id": "fira-sans",
        "name": "Fira Sans",
        "license": "OFL 1.1 (Mozilla, Erik Spiekermann)",
        "faces": {
            "400-normal": ("ofl/firasans/FiraSans-Regular.ttf", None),
            "700-normal": ("ofl/firasans/FiraSans-Bold.ttf", None),
            "400-italic": ("ofl/firasans/FiraSans-Italic.ttf", None),
        },
    },
    {
        "id": "source-sans-3",
        "name": "Source Sans 3",
        "license": "OFL 1.1 (Adobe)",
        "faces": {
            "400-normal": ("ofl/sourcesans3/SourceSans3[wght].ttf", 400),
            "700-normal": ("ofl/sourcesans3/SourceSans3[wght].ttf", 700),
            "400-italic": ("ofl/sourcesans3/SourceSans3-Italic[wght].ttf", 400),
        },
    },
    {
        "id": "ubuntu",
        "name": "Ubuntu",
        "license": "Ubuntu Font License 1.0 (Canonical)",
        "faces": {
            "400-normal": ("ufl/ubuntu/Ubuntu-Regular.ttf", None),
            "700-normal": ("ufl/ubuntu/Ubuntu-Bold.ttf", None),
            "400-italic": ("ufl/ubuntu/Ubuntu-Italic.ttf", None),
        },
    },
    {
        "id": "fira-code",
        "name": "Fira Code",
        "license": "OFL 1.1 (Nikita Prokopov)",
        "faces": {
            "400-normal": ("ofl/firacode/FiraCode[wght].ttf", 400),
            "700-normal": ("ofl/firacode/FiraCode[wght].ttf", 700),
        },
    },
    {
        "id": "golos-text",
        "name": "Golos Text",
        "license": "OFL 1.1 (Paratype)",
        "faces": {
            "400-normal": ("ofl/golostext/GolosText[wght].ttf", 400),
            "700-normal": ("ofl/golostext/GolosText[wght].ttf", 700),
        },
    },
    {
        "id": "open-sans",
        "name": "Open Sans",
        "license": "OFL 1.1 (Google)",
        "faces": {
            "400-normal": ("ofl/opensans/OpenSans[wdth,wght].ttf", 400),
            "700-normal": ("ofl/opensans/OpenSans[wdth,wght].ttf", 700),
            "400-italic": ("ofl/opensans/OpenSans-Italic[wdth,wght].ttf", 400),
        },
    },
    {
        "id": "liberation-sans",
        "name": "Liberation Sans",
        "license": "SIL OFL 1.1 (Red Hat, Liberation Fonts)",
        "local": True,
        "faces": {
            "400-normal": ("LiberationSans-Regular.ttf", None),
            "700-normal": ("LiberationSans-Bold.ttf", None),
            "400-italic": ("LiberationSans-Italic.ttf", None),
        },
    },
]


def download(url: str, target: Path) -> None:
    if target.exists() and target.stat().st_size > 0:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=120) as response:  # noqa: S310 — доверенный источник
        data = response.read()
    target.write_bytes(data)


def instance(source: Path, target: Path, weight: int) -> None:
    """Закрепить вариативный шрифт на нужном весе (статический экземпляр)."""
    from fontTools import ttLib
    from fontTools.varLib import instancer

    font = ttLib.TTFont(str(source))
    if "fvar" not in font:
        target.write_bytes(source.read_bytes())
        return
    axes = {axis.axisTag: axis.defaultValue for axis in font["fvar"].axes}
    axes["wght"] = weight
    instanced = instancer.instantiateVariableFont(font, axes, inplace=False, updateFontNames=True)
    instanced.save(str(target))


# Что оставляем в шрифтах: латиница, кириллица, греческий, пунктуация и символы,
# которые реально встречаются в документах. Полные файлы весят 20+ МБ, а это
# ровно тот набор, который нужен редактору для русских и английских текстов.
SUBSET_RANGES = (
    "U+0020-007E,U+00A0-00FF,U+0100-017F,U+0180-024F,U+02B0-02FF,U+0300-036F,"
    "U+0370-03FF,U+0400-04FF,U+0500-052F,U+1E00-1EFF,U+1F00-1FFF,"
    "U+2000-206F,U+20A0-20CF,U+2100-214F,U+2190-21FF,U+2200-22FF,"
    "U+2500-257F,U+25A0-25FF,U+2600-26FF,U+2700-27BF,U+FB00-FB06,U+FEFF"
)
SUBSET_FEATURES = "kern,liga,clig,calt,ccmp,locl,mark,mkmk,rlig,onum,tnum,frac,sups,subs"


def subset(target: Path) -> None:
    """Уменьшить файл до нужных наборов символов (в том же файле)."""
    from fontTools import subset as ft_subset

    options = ft_subset.Options()
    options.layout_features = SUBSET_FEATURES.split(",")
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.recommended_glyphs = True
    options.symbol_cmap = True
    options.legacy_cmap = True
    options.glyph_names = True
    options.hinting = True

    font = ft_subset.load_font(str(target), options)
    subsetter = ft_subset.Subsetter(options=options)
    subsetter.populate(unicodes=ft_subset.parse_unicodes(SUBSET_RANGES))
    subsetter.subset(font)
    ft_subset.save_font(font, str(target), options)
    font.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="public/fonts")
    parser.add_argument("--report", default=".tmp/fonts-report.json")
    parser.add_argument("--cache", default=".tmp/fontsrc")
    parser.add_argument("--local-dir", default=os.environ.get("LIBERATION_DIR", ""), help="каталог с локальными TTF (Liberation)")
    parser.add_argument("--no-subset", action="store_true", help="не уменьшать файлы до нужных наборов символов")
    args = parser.parse_args()

    out_dir = Path(args.out)
    cache_dir = Path(args.cache)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = []

    for family in FAMILIES:
        faces = {}
        stem = family["name"].replace(" ", "")
        for key, (file_name, weight) in family["faces"].items():
            suffix = "Regular" if key == "400-normal" else "Bold" if key == "700-normal" else "Italic"
            target = out_dir / f"{stem}-{suffix}.ttf"
            try:
                if family.get("local"):
                    if not args.local_dir:
                        raise RuntimeError("не задан LIBERATION_DIR / --local-dir")
                    source = Path(args.local_dir) / file_name
                else:
                    source = cache_dir / Path(file_name).name
                    download(f"{REPO}/{file_name}", source)
                if weight is None:
                    target.write_bytes(source.read_bytes())
                else:
                    instance(source, target, weight)
                if not args.no_subset:
                    subset(target)
            except Exception as error:  # noqa: BLE001 — печатаем и идём дальше
                print(f"  x {family['name']} {key}: {error}", file=sys.stderr)
                continue

            faces[key] = {"weight": int(key.split("-")[0]), "style": key.split("-")[1], "url": f"/{target.name}"}
            report.append({"id": family["id"], "name": family["name"], "key": key, "file": target.name, "size": target.stat().st_size})

        if faces:
            print(f"  {family['name']}: {len(faces)} начертаний")

    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(
        json.dumps(
            {
                "families": [
                    {
                        "id": family["id"],
                        "name": family["name"],
                        "license": family["license"],
                        "faces": {
                            key: {
                                "weight": int(key.split("-")[0]),
                                "style": key.split("-")[1],
                                "url": "/" + f"{family['name'].replace(' ', '')}-"
                                + ("Regular" if key == "400-normal" else "Bold" if key == "700-normal" else "Italic")
                                + ".ttf",
                            }
                            for key in family["faces"]
                        },
                    }
                    for family in FAMILIES
                ],
                "report": report,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Готово: {len(report)} файлов, отчёт {args.report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
