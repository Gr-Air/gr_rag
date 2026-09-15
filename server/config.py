"""集中配置（Spec 038）。

沿用 Spec 035 约束：业务代码不直接读 os.environ，统一从 Settings 取值。
pydantic-settings 自动从环境变量与项目根 .env / .env.local 读取。
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# server/ 的上一级即 llm-wiki/ 项目根
PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(PROJECT_ROOT / ".env", PROJECT_ROOT / ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- LLM（OpenAI 兼容接口） ---
    openai_api_key: str = ""
    openai_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    llm_model: str = "qwen3.7-max"
    # 兼容历史变量名（.env 中可能使用 LLM_API_KEY / LLM_BASE_URL）
    llm_api_key: str = ""
    llm_base_url: str = ""

    # --- Embedding（DashScope） ---
    dashscope_api_key: str = ""
    embedding_model: str = "text-embedding-v4"
    embedding_dim: int = 1024

    # --- 路径 ---
    raw_dir: Path = PROJECT_ROOT.parent / "Raw"
    wiki_dir: Path = PROJECT_ROOT.parent / "Wiki"
    data_dir: Path = PROJECT_ROOT / "src" / "data"

    # --- 服务 ---
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]

    @property
    def effective_api_key(self) -> str:
        return self.openai_api_key or self.llm_api_key

    @property
    def effective_base_url(self) -> str:
        return self.openai_base_url or self.llm_base_url


@lru_cache
def get_settings() -> Settings:
    """进程级单例。"""
    return Settings()
