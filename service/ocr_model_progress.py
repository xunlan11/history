"""Observe PaddleX generators without changing inference inputs or results.

Percent is completion of configured pipeline steps (equal steps, with actual
recognition counts inside the text step), never an estimate of elapsed time.
Only the final successful HTTP response completes the result step.
"""
from __future__ import annotations

import contextvars
import math
import threading
import time
from contextlib import closing
from typing import Any

CURRENT = contextvars.ContextVar("ocr_model_progress", default=None)
SCOPE = contextvars.ContextVar("ocr_model_scope", default="")
LABELS = {
    "preprocessing": "页面预处理", "layout_detection": "版面检测",
    "region_detection": "区域检测", "text_detection": "文字检测",
    "textline_orientation": "文字方向识别", "text_recognition": "文字识别",
    "table_recognition": "表格解析", "result": "整理识别结果",
}


class ProgressStore:
    def __init__(self, ttl=300, limit=1024, max_age=1800):
        self.ttl, self.limit, self.max_age = ttl, limit, max_age
        self.lock = threading.Lock()
        self.entries: dict[str, dict[str, Any]] = {}

    def _expired(self, entry, now):
        age = now - entry.get("updatedAt", 0)
        if age > self.max_age:
            # 请求在写出最终响应前中断时，条目否则会永远停在 running；
            # 进度键按推理批次隔离，之后不会再有人读取。
            return True
        return entry.get("status") in {"completed", "failed"} and age > self.ttl

    def write(self, key, **entry):
        now = time.time()
        with self.lock:
            for name, old in list(self.entries.items()):
                if self._expired(old, now):
                    self.entries.pop(name, None)
            if key not in self.entries and len(self.entries) >= self.limit:
                # 容量不足时拒绝登记，绝不淘汰仍在进行的推理。
                finished = next((name for name, old in self.entries.items()
                                 if old.get("status") in {"completed", "failed"}), None)
                if finished is None:
                    return
                self.entries.pop(finished)
            self.entries[key] = {**entry, "updatedAt": now}

    def read(self, key):
        with self.lock:
            entry = self.entries.get(key)
            if entry and self._expired(entry, time.time()):
                self.entries.pop(key, None)
                entry = None
            return dict(entry) if entry else {"percent": 0, "updatedAt": 0}


class InferenceProgress:
    def __init__(self, store, key, config):
        self.store, self.key, self.config = store, key, config
        self.steps: list[str] = []
        self.finished: set[str] = set()
        self.fractions: dict[str, float] = {}
        self.entry = dict(percent=0, stage="等待模型执行", status="queued", basis="pipeline_steps",
                          completed=0, total=0, unit="", completedSteps=0, totalSteps=0)
        self.publish()

    def publish(self, **values):
        self.entry.update(values)
        self.store.write(self.key, **self.entry)

    def start(self, options):
        if self.entry["status"] == "failed":
            return

        def enabled(name, default=True):
            value = options.get(name)
            return bool(self.config.get(name, default) if value is None else value)

        self.steps = []
        if enabled("use_doc_orientation_classify", self.config.get("use_doc_preprocessor", True)) or enabled("use_doc_unwarping", self.config.get("use_doc_preprocessor", True)):
            self.steps.append("preprocessing")
        self.steps.append("layout_detection")  # PP-StructureV3 总会执行版面检测。
        if enabled("use_region_detection"):
            self.steps.append("region_detection")
        self.steps.append("text_detection")
        if enabled("use_textline_orientation"):
            self.steps.append("textline_orientation")
        self.steps.append("text_recognition")
        if enabled("use_table_recognition"):
            self.steps.append("table_recognition")
        self.steps.append("result")
        self.publish(status="running", totalSteps=len(self.steps))

    def update(self, step, done=0, total=0, unit="", finished=False):
        if step not in self.steps or self.entry["status"] == "failed":
            return
        if finished:
            self.finished.add(step)
        fraction = 1.0 if finished else min(1, done / total) if total else 0
        self.fractions[step] = fraction
        percent = math.floor(100 * sum(self.fractions.values()) / len(self.steps))
        self.publish(percent=min(99, max(self.entry["percent"], percent)), stage=LABELS[step],
                     completed=done, total=total, unit=unit,
                     completedSteps=len(self.finished), totalSteps=len(self.steps))

    def finish_ocr(self):
        # 空白页本来就会跳过方向分类与识别生成器。
        for step in ("text_detection", "textline_orientation", "text_recognition"):
            if step in self.steps and step not in self.finished:
                self.update(step, finished=True)

    def finish(self):
        if self.entry["status"] != "failed":
            self.publish(percent=100, stage="识别完成", status="completed",
                         completedSteps=len(self.steps), completed=0, total=0, unit="")

    def fail(self):
        self.publish(status="failed")


class ObservedPredictor:
    """Proxy only generator calls; attributes and every yielded object pass through."""
    def __init__(self, target, step):
        self.target, self.step = target, step

    def __getattr__(self, name):
        return getattr(self.target, name)

    def __call__(self, *args, **kwargs):
        return self._observe(self.target, *args, **kwargs)

    def predict(self, *args, **kwargs):
        return self._observe(self.target.predict, *args, **kwargs)

    def _observe(self, method, *args, **kwargs):
        tracker = CURRENT.get()
        scope = SCOPE.get()
        is_text = self.step.startswith("text")
        active = tracker is not None and (not is_text or scope == "ocr")
        if not active:
            yield from method(*args, **kwargs)
            return
        if self.step == "root":
            tracker.start(kwargs)
        token = None
        if self.step in {"ocr", "table_recognition"}:
            if scope == "table":
                yield from method(*args, **kwargs)
                return
            token = SCOPE.set("ocr" if self.step == "ocr" else "table")
        inputs = args[0] if args else kwargs.get("input")
        total = len(inputs) if isinstance(inputs, (list, tuple)) else 1
        done = 0
        unit = "文字区域" if self.step in {"text_recognition", "textline_orientation"} else "页"
        tracker.update(self.step, 0, total, unit)
        try:
            with closing(method(*args, **kwargs)) as results:
                for result in results:
                    if isinstance(result, dict) and "error" in result:
                        tracker.fail()
                    done += 1
                    tracker.update(self.step, done, total, unit)
                    yield result
            if self.step == "ocr":
                tracker.finish_ocr()
            elif self.step == "root":
                tracker.update("result")
            else:
                tracker.update(self.step, done, total, unit, finished=True)
        except BaseException:
            tracker.fail()
            raise
        finally:
            if token is not None:
                SCOPE.reset(token)


def instrument_pipeline(pipeline):
    """CPU PaddleX AutoParallel containers hold the real pipeline in _pipeline."""
    seen = set()
    observed = set()
    attrs = {
        "doc_preprocessor_pipeline": "preprocessing", "layout_det_model": "layout_detection",
        "region_detection_model": "region_detection", "general_ocr_pipeline": "ocr",
        "text_det_model": "text_detection", "textline_orientation_model": "textline_orientation",
        "text_rec_model": "text_recognition", "table_recognition_pipeline": "table_recognition",
    }

    def visit(node):
        if id(node) in seen:
            return
        seen.add(id(node))
        # 只遍历已知的模型容器，不下钻张量内部。
        inner = vars(node).get("_pipeline")
        if inner is not None:
            visit(inner)
        if vars(node).get("_multi_device_inference"):
            raise RuntimeError("OCR progress launcher requires the configured CPU single-device pipeline")
        for name, step in attrs.items():
            child = vars(node).get(name)
            if child is not None:
                visit(child)
                setattr(node, name, ObservedPredictor(child, step))
                observed.add(step)

    visit(pipeline)
    if not {"layout_detection", "text_detection", "text_recognition"}.issubset(observed):
        raise RuntimeError("Unsupported PaddleX pipeline: required OCR progress hooks were not found")
    return ObservedPredictor(pipeline, "root")
