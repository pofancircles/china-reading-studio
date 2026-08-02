from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

Level = Literal["HSK1", "HSK2", "HSK3", "HSK4"]
NativeLang = Literal["English", "Vietnamese"]
GenerationComponent = Literal["vocab", "questions", "lesson_plan"]


class AnalyzeRequest(BaseModel):
    text: str = Field(min_length=10, max_length=8000)
    level: Level


class GenerateRequest(BaseModel):
    text: str = Field(min_length=10, max_length=8000)
    level: Level
    native_lang: NativeLang = "English"
    keep_words: list[str] = Field(default_factory=list, max_length=12)

    @field_validator("keep_words")
    @classmethod
    def clean_keep_words(cls, values: list[str]) -> list[str]:
        cleaned: list[str] = []
        for value in values:
            value = value.strip()
            if value and value not in cleaned and len(value) <= 24:
                cleaned.append(value)
        return cleaned


class ModelProbeRequest(BaseModel):
    """Bound the live probe so the diagnostics endpoint stays lightweight."""

    timeout_seconds: float = Field(default=30.0, ge=2.0, le=60.0)


class GenerateComponentRequest(BaseModel):
    component: GenerationComponent
    rewritten_text: str = Field(min_length=1, max_length=8000)
    level: Level
    native_lang: NativeLang = "English"
    target_words: list[str] = Field(default_factory=list, max_length=12)

    @field_validator("target_words")
    @classmethod
    def clean_target_words(cls, values: list[str]) -> list[str]:
        cleaned: list[str] = []
        for value in values:
            value = value.strip()
            if value and value not in cleaned and len(value) <= 24:
                cleaned.append(value)
        return cleaned


class SentenceItem(BaseModel):
    text: str
    source_sentence_ids: list[int] = Field(default_factory=list)


class RewrittenResult(BaseModel):
    title: str
    sentences: list[SentenceItem]
    deleted_info: str = ""
    teacher_notes: str = ""
