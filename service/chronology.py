from __future__ import annotations

import re
from datetime import date
from typing import Any

try:
    from lunar_python import Lunar, Solar
except ImportError:  # 服务仍可启动，但精确农历换算会返回待核提示。
    Lunar = None
    Solar = None


ERA_DEFINITIONS = {
    "天命": (1616, 1626, "lunar"),
    "天聪": (1627, 1635, "lunar"),
    "崇德": (1636, 1643, "lunar"),
    "顺治": (1644, 1661, "lunar"),
    "康熙": (1662, 1722, "lunar"),
    "雍正": (1723, 1735, "lunar"),
    "乾隆": (1736, 1795, "lunar"),
    "嘉庆": (1796, 1820, "lunar"),
    "道光": (1821, 1850, "lunar"),
    "咸丰": (1851, 1861, "lunar"),
    "同治": (1862, 1874, "lunar"),
    "光绪": (1875, 1908, "lunar"),
    "宣统": (1909, 1911, "lunar"),
    "民国": (1912, None, "gregorian"),
}

# 仅收录繁体→简体不一致的年号；康熙/雍正/乾隆/道光/同治繁简同形，
# 已在 ERA_DEFINITIONS 中，无需别名。
ERA_ALIASES = {
    "天聰": "天聪",
    "順治": "顺治",
    "嘉慶": "嘉庆",
    "咸豐": "咸丰",
    "光緒": "光绪",
    "宣統": "宣统",
    "民國": "民国",
}

HEAVENLY_STEMS = "甲乙丙丁戊己庚辛壬癸"
EARTHLY_BRANCHES = "子丑寅卯辰巳午未申酉戌亥"
SEXAGENARY_CYCLE = tuple(
    HEAVENLY_STEMS[index % 10] + EARTHLY_BRANCHES[index % 12]
    for index in range(60)
)

CHINESE_DIGITS = {
    "〇": 0,
    "零": 0,
    "○": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "兩": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}

CHINESE_NUMBER_PATTERN = "〇零○一二两兩三四五六七八九十百千廿卅卌元初正冬腊臘"
ERA_PATTERN = "|".join(
    sorted(
        {re.escape(name) for name in (*ERA_DEFINITIONS.keys(), *ERA_ALIASES.keys())},
        key=len,
        reverse=True,
    )
)


def normalize_chronicle_entries(
    entries: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    normalized: list[tuple[int, dict[str, Any]]] = []
    warnings: list[str] = []

    for index, entry in enumerate(entries):
        normalized_entry, entry_warnings = normalize_chronicle_entry(entry)
        normalized.append((index, normalized_entry))
        warnings.extend(f"第 {index + 1} 条：{warning}" for warning in entry_warnings)

    normalized.sort(key=lambda pair: chronicle_sort_key(pair[1], pair[0]))
    result = [entry for _, entry in normalized]
    previous_exact_date = ""
    for entry in result:
        current_date = string_value(entry.get("dateGregorian"))
        is_exact = re.fullmatch(r"\d{4}-\d{2}-\d{2}", current_date) is not None
        entry["sameDay"] = bool(is_exact and current_date == previous_exact_date)
        previous_exact_date = current_date if is_exact else ""

    return result, unique_strings(warnings)


def normalize_chronicle_entry(
    entry: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    value = dict(entry)
    warnings: list[str] = []
    original = string_value(value.get("dateOriginal")).strip()
    parse_text = original or string_value(value.get("dateLabel")).strip()

    era_name, era_year = extract_era(value, parse_text)
    era_definition = ERA_DEFINITIONS.get(era_name)
    era_label = f"{era_name}{chinese_number(era_year)}年" if era_name and era_year else ""
    absolute_year = 0
    era_calendar = ""
    era_invalid = False
    if era_definition and era_year:
        start_year, end_year, era_calendar = era_definition
        absolute_year = start_year + era_year - 1
        if era_year < 1 or (end_year is not None and absolute_year > end_year):
            warnings.append(f"{era_label}超出该年号的有效范围，公历年份待核。")
            absolute_year = 0
            era_invalid = True

    explicit_date = extract_absolute_date(parse_text)
    structured_year = positive_int(value.get("year"))
    structured_month = positive_int(value.get("month"))
    structured_day = positive_int(value.get("day"))
    calendar_type = normalize_calendar_type(value.get("calendarType"))
    if has_lunar_marker(parse_text):
        calendar_type = "lunar"

    if explicit_date:
        structured_year, structured_month, structured_day = explicit_date
        calendar_type = "lunar" if has_lunar_marker(parse_text) else "gregorian"
    elif era_invalid:
        structured_year = 0

    lunar_month, lunar_day, lunar_leap = extract_lunar_date(value, parse_text)
    if lunar_month:
        structured_month = lunar_month
    if lunar_day:
        structured_day = lunar_day
    if lunar_leap:
        value["lunarLeap"] = True

    if absolute_year:
        if structured_year and structured_year != absolute_year:
            warnings.append(
                f"结构化年份 {structured_year} 与{era_label}换算的 {absolute_year} 年冲突，采用年号换算。"
            )
        structured_year = absolute_year
        if has_lunar_marker(parse_text):
            calendar_type = "lunar"
        elif has_gregorian_marker(parse_text):
            calendar_type = "gregorian"
        else:
            calendar_type = era_calendar

    model_gregorian = parse_iso_date(string_value(value.get("dateGregorian")))
    ganzhi_original = extract_ganzhi(value, parse_text)
    if not structured_year and model_gregorian and not era_invalid:
        model_parts = [int(part) for part in model_gregorian.split("-")]
        model_year = model_parts[0]
        if not ganzhi_original or ganzhi_for_year(model_year) == ganzhi_original:
            structured_year = model_year
            structured_month = model_parts[1] if len(model_parts) > 1 else 0
            structured_day = model_parts[2] if len(model_parts) > 2 else 0
            calendar_type = calendar_type or "gregorian"

    if not structured_year and ganzhi_original:
        mark_unresolved(value, era_label, f"{ganzhi_original}年", original or f"{ganzhi_original}年", "公历年份待核")
        warnings.append(f"{ganzhi_original}年每六十年重复，缺少时代锚点，不能唯一换算。")
        return value, warnings

    if not structured_year:
        # 走到这里说明 ganzhi_original 为空（非空时上一个分支已返回）。
        mark_unresolved(value, era_label, "", original or "日期待核", "公历待核")
        return value, warnings

    if calendar_type == "lunar":
        converted = convert_lunar_date(
            structured_year,
            structured_month,
            structured_day,
            boolean_value(value.get("lunarLeap")),
        )
    else:
        converted = convert_gregorian_date(structured_year, structured_month, structured_day)

    warnings.extend(converted.pop("warnings"))
    value.update(converted)
    value["dateEra"] = era_label
    value["calendarType"] = calendar_type or "unknown"

    calculated_ganzhi = string_value(value.get("dateGanzhi")).removesuffix("年")
    if ganzhi_original and calculated_ganzhi and ganzhi_original != calculated_ganzhi:
        warnings.append(
            f"原文干支 {ganzhi_original} 与换算所得 {calculated_ganzhi} 不一致，保留绝对日期并提示核验。"
        )
        value["calendarConversionStatus"] = "conflict"

    value["dateLabel"] = build_date_label(value, original, era_label)
    return value, warnings


def convert_lunar_date(year: int, month: int, day: int, leap: bool) -> dict[str, Any]:
    warnings: list[str] = []
    base = {
        "dateGregorian": str(year),
        "dateLunar": format_lunar_date(year, month, day, leap),
        "dateGanzhi": f"{ganzhi_for_year(year)}年",
        "datePrecision": "year",
        "calendarConversionStatus": "partial",
        "warnings": warnings,
    }
    if not month or not day:
        if month:
            warnings.append("只有农历月份而没有日期，无法换算为唯一公历月份。")
        return base
    if Lunar is None:
        warnings.append("未安装 lunar-python，无法执行农历与公历的精确换算。")
        return base

    try:
        lunar = Lunar.fromYmd(year, -month if leap else month, day)
        solar = lunar.getSolar()
        solar_year = solar.getYear()
        solar_month = solar.getMonth()
        solar_day = solar.getDay()
        base.update(
            {
                "dateGregorian": f"{solar_year:04d}-{solar_month:02d}-{solar_day:02d}",
                "dateGanzhi": f"{lunar.getYearInGanZhi()}年",
                "datePrecision": "day",
                "calendarConversionStatus": "converted",
            }
        )
    except Exception as exc:  # 第三方历法库对无效历史日期可能抛出普通 Exception。
        warnings.append(f"农历日期无效或无法换算：{exc}")
    return base


def convert_gregorian_date(year: int, month: int, day: int) -> dict[str, Any]:
    warnings: list[str] = []
    precision = "year"
    gregorian = str(year)
    if month:
        if not 1 <= month <= 12:
            warnings.append(f"公历月份 {month} 无效。")
        elif day:
            try:
                date(year, month, day)
                gregorian = f"{year:04d}-{month:02d}-{day:02d}"
                precision = "day"
            except ValueError as exc:
                warnings.append(f"公历日期无效：{exc}")
        else:
            gregorian = f"{year:04d}-{month:02d}"
            precision = "month"

    result = {
        "dateGregorian": gregorian,
        "dateLunar": "",
        "dateGanzhi": f"{ganzhi_for_year(year)}年",
        "datePrecision": precision,
        "calendarConversionStatus": "normalized" if precision != "year" else "partial",
        "warnings": warnings,
    }
    if precision != "day" or Solar is None:
        if precision == "day" and Solar is None:
            warnings.append("未安装 lunar-python，无法补充对应农历日期。")
        return result

    try:
        lunar = Solar.fromYmd(year, month, day).getLunar()
        lunar_month = abs(lunar.getMonth())
        result["dateLunar"] = format_lunar_date(
            lunar.getYear(), lunar_month, lunar.getDay(), lunar.getMonth() < 0
        )
        result["dateGanzhi"] = f"{lunar.getYearInGanZhi()}年"
        result["calendarConversionStatus"] = "converted"
    except Exception as exc:  # 第三方历法库对越界日期的异常类型不固定。
        warnings.append(f"公历转农历失败：{exc}")
    return result


def extract_era(value: dict[str, Any], text: str) -> tuple[str, int]:
    raw_name = string_value(value.get("eraName")).strip()
    era_name = canonical_era(raw_name)
    era_year = positive_int(value.get("eraYear"))
    if era_name and era_year:
        return era_name, era_year

    match = re.search(
        rf"(?P<name>{ERA_PATTERN})(?P<year>[0-9０-９{CHINESE_NUMBER_PATTERN}]+)年",
        text,
    )
    if not match:
        return era_name, era_year
    return canonical_era(match.group("name")), parse_chinese_number(match.group("year"))


def extract_absolute_date(text: str) -> tuple[int, int, int] | None:
    match = re.search(
        rf"(?P<year>[0-9０-９]{{4}}|[〇零○一二三四五六七八九]{{4}})[年./-]"
        rf"(?:(?P<month>[0-9０-９]{{1,2}}|[{CHINESE_NUMBER_PATTERN}]+)[月./-])?"
        rf"(?:(?P<day>[0-9０-９]{{1,2}}|[{CHINESE_NUMBER_PATTERN}]+)(?:日|号)?)?",
        text,
    )
    if not match:
        return None
    return (
        parse_chinese_number(match.group("year")),
        parse_chinese_number(match.group("month")),
        parse_chinese_number(match.group("day")),
    )


def extract_lunar_date(value: dict[str, Any], text: str) -> tuple[int, int, bool]:
    month = positive_int(value.get("lunarMonth"))
    day = positive_int(value.get("lunarDay"))
    leap = boolean_value(value.get("lunarLeap"))
    match = re.search(
        rf"(?P<leap>闰|閏)?(?P<month>正|冬|腊|臘|[0-9０-９{CHINESE_NUMBER_PATTERN}]+)月"
        rf"(?:(?P<day>[0-9０-９{CHINESE_NUMBER_PATTERN}]+)(?:日|号)?)?",
        text,
    )
    if match:
        month = parse_chinese_number(match.group("month")) or month
        day = parse_chinese_number(match.group("day")) or day
        leap = bool(match.group("leap")) or leap
    return month, day, leap


def extract_ganzhi(value: dict[str, Any], text: str) -> str:
    candidate = string_value(value.get("ganzhiYear")).strip().removesuffix("年")
    if candidate in SEXAGENARY_CYCLE:
        return candidate
    match = re.search(r"([甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥])年", text)
    return match.group(1) if match and match.group(1) in SEXAGENARY_CYCLE else ""


def parse_chinese_number(value: Any) -> int:
    text = string_value(value).strip() if not isinstance(value, int) else str(value)
    if not text:
        return 0
    text = text.translate(str.maketrans("０１２３４５６７８９", "0123456789"))
    text = text.removesuffix("年").removeprefix("初").replace("元", "一")
    if text.isdigit():
        return int(text)
    if text == "正":
        return 1
    if text in {"冬"}:
        return 11
    if text in {"腊", "臘"}:
        return 12
    if text.startswith("廿"):
        return 20 + parse_chinese_number(text[1:])
    if text.startswith("卅"):
        return 30 + parse_chinese_number(text[1:])
    if text.startswith("卌"):
        return 40 + parse_chinese_number(text[1:])
    if all(char in CHINESE_DIGITS for char in text):
        return int("".join(str(CHINESE_DIGITS[char]) for char in text))

    total = 0
    current = 0
    for char in text:
        if char in CHINESE_DIGITS:
            current = CHINESE_DIGITS[char]
        elif char in {"十", "百", "千"}:
            unit = {"十": 10, "百": 100, "千": 1000}[char]
            total += (current or 1) * unit
            current = 0
        else:
            return 0
    return total + current


def parse_iso_date(value: str) -> str:
    match = re.fullmatch(r"(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?", value.strip())
    if not match:
        return ""
    year = int(match.group(1))
    month = int(match.group(2) or 0)
    day = int(match.group(3) or 0)
    if month and not 1 <= month <= 12:
        return ""
    if day:
        try:
            date(year, month, day)
        except ValueError:
            return ""
    return value.strip()


def format_lunar_date(year: int, month: int, day: int, leap: bool) -> str:
    if not month:
        return str(year)
    month_label = lunar_month_name(month)
    if not day:
        return f"{year}年{'闰' if leap else ''}{month_label}月"
    return f"{year}年{'闰' if leap else ''}{month_label}月{lunar_day_name(day)}"


def lunar_month_name(month: int) -> str:
    names = ("", "正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊")
    return names[month] if 1 <= month <= 12 else str(month)


def lunar_day_name(day: int) -> str:
    if not 1 <= day <= 30:
        return str(day)
    if day <= 10:
        return "初" + ("一二三四五六七八九十"[day - 1])
    if day < 20:
        return "十" + "一二三四五六七八九"[day - 11]
    if day == 20:
        return "二十"
    if day < 30:
        return "廿" + "一二三四五六七八九"[day - 21]
    return "三十"


def ganzhi_for_year(year: int) -> str:
    return SEXAGENARY_CYCLE[(year - 4) % 60]


def build_date_label(value: dict[str, Any], original: str, era_label: str) -> str:
    gregorian = string_value(value.get("dateGregorian"))
    precision = string_value(value.get("datePrecision"))
    primary = format_gregorian_label(gregorian)
    details: list[str] = []
    if original and original != primary:
        details.append(original)
    elif era_label and era_label not in original:
        details.append(era_label)
    lunar = string_value(value.get("dateLunar"))
    lunar_tail = lunar.split("年", 1)[-1]
    if lunar and precision == "day" and not has_lunar_marker(original) and lunar_tail not in original:
        details.append(f"农历{lunar_tail}")
    ganzhi = string_value(value.get("dateGanzhi"))
    if ganzhi and ganzhi not in original:
        details.append(ganzhi)
    if value.get("calendarConversionStatus") == "conflict":
        details.append("纪年冲突待核")
    return f"{primary}（{'；'.join(unique_strings(details))}）" if details else primary


def format_gregorian_label(value: str) -> str:
    parts = value.split("-")
    if len(parts) == 3:
        return f"{int(parts[0])}年{int(parts[1])}月{int(parts[2])}日"
    if len(parts) == 2:
        return f"{int(parts[0])}年{int(parts[1])}月"
    return f"{int(parts[0])}年" if parts and parts[0].isdigit() else "日期待核"


def pending_label(original: str, suffix: str) -> str:
    return f"{original}（{suffix}）" if suffix not in original else original


def mark_unresolved(
    value: dict[str, Any],
    era_label: str,
    ganzhi_label: str,
    label_source: str,
    label_suffix: str,
) -> None:
    value.update(
        {
            "dateGregorian": "",
            "dateLunar": "",
            "dateGanzhi": ganzhi_label,
            "dateEra": era_label,
            "datePrecision": "unknown",
            "calendarConversionStatus": "unresolved",
            "dateLabel": pending_label(label_source, label_suffix),
        }
    )


def chronicle_sort_key(entry: dict[str, Any], original_index: int) -> tuple[int, int, int, int, int]:
    gregorian = string_value(entry.get("dateGregorian"))
    match = re.fullmatch(r"(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?", gregorian)
    if not match:
        return (1, 9999, 12, 31, original_index)
    return (
        0,
        int(match.group(1)),
        int(match.group(2) or 0),
        int(match.group(3) or 0),
        original_index,
    )


def canonical_era(value: str) -> str:
    return ERA_ALIASES.get(value, value if value in ERA_DEFINITIONS else "")


def normalize_calendar_type(value: Any) -> str:
    text = string_value(value).strip().lower()
    aliases = {
        "公历": "gregorian",
        "阳历": "gregorian",
        "solar": "gregorian",
        "gregorian": "gregorian",
        "农历": "lunar",
        "阴历": "lunar",
        "旧历": "lunar",
        "lunar": "lunar",
    }
    return aliases.get(text, "")


def has_lunar_marker(value: str) -> bool:
    return any(marker in value for marker in ("农历", "農曆", "阴历", "陰曆", "旧历", "舊曆"))


def has_gregorian_marker(value: str) -> bool:
    return any(marker in value for marker in ("公历", "公曆", "阳历", "陽曆", "西历", "西曆"))


def positive_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value if value > 0 else 0
    if isinstance(value, float) and value.is_integer():
        return int(value) if value > 0 else 0
    if isinstance(value, str):
        parsed = parse_chinese_number(value)
        return parsed if parsed > 0 else 0
    return 0


def boolean_value(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "是"}
    return False


def chinese_number(value: int) -> str:
    if value == 1:
        return "元"
    digits = "零一二三四五六七八九"
    if value < 10:
        return digits[value]
    if value < 20:
        return "十" + (digits[value % 10] if value % 10 else "")
    if value < 100:
        return digits[value // 10] + "十" + (digits[value % 10] if value % 10 else "")
    return str(value)


def string_value(value: Any) -> str:
    return value if isinstance(value, str) else ""


def unique_strings(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))
