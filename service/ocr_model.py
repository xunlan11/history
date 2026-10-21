"""CPU PaddleX serving with request-isolated, observed OCR progress.

Run in the model venv: python -m service.ocr_model --pipeline PATH --port 8080.
The official /layout-parsing handler and response serialization stay intact.
"""
from __future__ import annotations

import argparse
import contextvars
import logging
from contextlib import asynccontextmanager

from service.ocr_model_progress import CURRENT, InferenceProgress, ProgressStore, instrument_pipeline

log = logging.getLogger(__name__)


class ProgressMiddleware:
    def __init__(self, app, store, config, enabled=True):
        self.app, self.store, self.config, self.enabled = app, store, config, enabled

    async def __call__(self, scope, receive, send):
        if not self.enabled or scope["type"] != "http" or scope["method"] != "POST" or scope["path"] != "/layout-parsing":
            return await self.app(scope, receive, send)
        key = dict(scope["headers"]).get(b"x-ocr-progress-key", b"").decode("ascii", "ignore")
        if not key or len(key) > 128:
            return await self.app(scope, receive, send)
        tracker = InferenceProgress(self.store, key, self.config)
        token = CURRENT.set(tracker)
        status = 500

        async def tracked_send(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                if 200 <= status < 300:
                    tracker.finish()
                else:
                    tracker.fail()

        try:
            await self.app(scope, receive, tracked_send)
        except BaseException:
            tracker.fail()
            raise
        finally:
            CURRENT.reset(token)


def create_app(pipeline, config):
    from paddlex.inference.serving.basic_serving import create_pipeline_app

    try:
        observed = instrument_pipeline(pipeline)
        tracking = True
    except Exception:  # noqa: BLE001 - 进度只是观测层，不能连带打挂识别服务
        log.exception("OCR 进度观测不可用：PaddleX 管线结构与预期不符，改为只提供识别")
        observed, tracking = pipeline, False
    app = create_pipeline_app(observed, config)
    store = ProgressStore()
    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app):
        async with original_lifespan(app):
            if tracking:
                wrapper = app.state.context.pipeline
                original_call = wrapper.call

                async def tracked_call(func, *args, **kwargs):
                    # PaddleX uses a dedicated serial worker thread. ContextVars do not
                    # cross its queue unless explicitly copied at submission time.
                    context = contextvars.copy_context()
                    return await original_call(lambda: context.run(func, *args, **kwargs))

                wrapper.call = tracked_call
            yield

    app.router.lifespan_context = lifespan
    app.add_middleware(ProgressMiddleware, store=store, config=config, enabled=tracking)

    @app.get("/layout-parsing/progress/{key}")
    async def progress(key: str):
        return {"key": key, **store.read(key)}

    app.state.ocr_progress_store = store
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pipeline", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    from paddlex import create_pipeline
    from paddlex.inference.pipelines import load_pipeline_config
    from paddlex.inference.serving.basic_serving import run_server

    config = load_pipeline_config(args.pipeline)
    pipeline = create_pipeline(config=config, device="cpu")
    run_server(create_app(pipeline, config), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
