from __future__ import annotations

import os
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from llm import get_model_status, probe_model
from schemas import AnalyzeRequest, GenerateComponentRequest, GenerateRequest, ModelProbeRequest
from security import get_access_status, require_model_access
from services import analyze_article, generate_component, generate_package, generate_rewrite_package

app = FastAPI(title="全世界都在说中国话", version="0.1.0")
cors_origins = ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:5173", "http://127.0.0.1:5173"]
cors_origins.extend(item.strip() for item in os.environ.get("CORS_ORIGINS", "").split(",") if item.strip())
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
async def readiness() -> dict[str, str]:
    model = get_model_status()
    access = get_access_status()
    if not model["configured"] or (access["access_required"] and not access["access_configured"]):
        raise HTTPException(status_code=503, detail="service_not_configured")
    return {"status": "ready"}


@app.get("/api/model-status")
async def model_status() -> dict[str, str | bool | int]:
    return {**get_model_status(), **get_access_status()}


@app.post("/api/model-probe")
async def model_probe(
    body: ModelProbeRequest | None = None,
    _access: None = Depends(require_model_access),
) -> dict[str, str | bool | int]:
    result = await probe_model(body.timeout_seconds if body else 30.0)
    status = get_model_status()
    return {**result, "provider": status["provider"], "model": status["model"]}


@app.post("/api/analyze")
async def analyze(body: AnalyzeRequest) -> dict:
    return analyze_article(body.text, body.level)


@app.post("/api/generate")
async def generate(body: GenerateRequest, _access: None = Depends(require_model_access)) -> dict:
    try:
        return await generate_package(body.text, body.level, body.native_lang, body.keep_words)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="生成失败，请稍后重试。") from exc


@app.post("/api/rewrite")
async def rewrite(body: GenerateRequest, _access: None = Depends(require_model_access)) -> dict:
    try:
        return await generate_rewrite_package(body.text, body.level, body.native_lang, body.keep_words)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="改写失败，请稍后重试。") from exc


@app.post("/api/generate-component")
async def regenerate_component(
    body: GenerateComponentRequest,
    _access: None = Depends(require_model_access),
) -> dict:
    return await generate_component(
        body.component,
        body.rewritten_text,
        body.level,
        body.native_lang,
        body.target_words,
    )


static_dir = Path(os.environ.get("FRONTEND_STATIC_DIR", Path(__file__).resolve().parent / "static")).resolve()
if static_dir.is_dir():
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="frontend")
