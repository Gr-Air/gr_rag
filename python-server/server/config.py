"""集中配置（Spec 038）。

沿用 Spec 035 约束：业务代码不直接读 os.environ，统一从 Settings 取值。
pydantic-settings 自动从仓库根 .env / .env.local 读取，字段名即环境变量名
（大小写不敏感），因此 RAW_DIR / WIKI_DIR / DATA_DIR 可直接覆盖默认路径。
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# server/ 的上一级即本仓库根目录（含 server/ tests/ Raw/ Wiki/）
PROJECT_ROOT = Path(__file__).resolve().parents[1]


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
    # 端点是否接受 temperature：严格推理模型（o3 / o1 / deepseek-r1 等）需置 false
    llm_supports_temperature: bool = True
    # 兼容历史变量名（.env 中可能使用 LLM_API_KEY / LLM_BASE_URL）
    llm_api_key: str = ""
    llm_base_url: str = ""

    # --- Embedding（DashScope） ---
    dashscope_api_key: str = ""
    embedding_model: str = "text-embedding-v4"
    embedding_dim: int = 1024

    # --- 路径（默认全部落在仓库内，保证 clone 即自包含） ---
    raw_dir: Path = PROJECT_ROOT / "Raw"
    wiki_dir: Path = PROJECT_ROOT / "Wiki"
    data_dir: Path = PROJECT_ROOT / "data"

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
