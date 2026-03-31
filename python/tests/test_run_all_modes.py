"""Tests for Phase 6 run_all.py integration — new CLI modes."""

import os
import sys
import subprocess
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

PYTHON = sys.executable
RUN_ALL = os.path.join(os.path.dirname(__file__), "..", "run_all.py")


class TestPhase6ArgsAccepted:
    """Verify the new CLI arguments are recognized by argparse."""

    def test_build_ai_context_flag_exists(self):
        """--build-ai-context should be a recognized flag."""
        result = subprocess.run(
            [PYTHON, RUN_ALL, "--build-ai-context", "--help"],
            capture_output=True, text=True, timeout=10,
        )
        # --help exits 0 and shows the flag in output
        assert result.returncode == 0
        assert "build-ai-context" in result.stdout

    def test_run_ai_analysis_flag_exists(self):
        result = subprocess.run(
            [PYTHON, RUN_ALL, "--run-ai-analysis", "--help"],
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0
        assert "run-ai-analysis" in result.stdout

    def test_ai_full_flag_exists(self):
        result = subprocess.run(
            [PYTHON, RUN_ALL, "--ai-full", "--help"],
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0
        assert "ai-full" in result.stdout

    def test_ai_provider_option(self):
        result = subprocess.run(
            [PYTHON, RUN_ALL, "--help"],
            capture_output=True, text=True, timeout=10,
        )
        assert "ai-provider" in result.stdout
        assert "openai" in result.stdout
        assert "anthropic" in result.stdout

    def test_ai_model_option(self):
        result = subprocess.run(
            [PYTHON, RUN_ALL, "--help"],
            capture_output=True, text=True, timeout=10,
        )
        assert "ai-model" in result.stdout

    def test_min_composite_option(self):
        result = subprocess.run(
            [PYTHON, RUN_ALL, "--help"],
            capture_output=True, text=True, timeout=10,
        )
        assert "min-composite" in result.stdout


class TestPhase6Functions:
    """Verify the pipeline functions are importable and structured correctly."""

    def test_ai_context_pipeline_importable(self):
        from run_all import _run_ai_context_pipeline
        assert callable(_run_ai_context_pipeline)

    def test_ai_analysis_pipeline_importable(self):
        from run_all import _run_ai_analysis_pipeline
        assert callable(_run_ai_analysis_pipeline)

    def test_pipeline_modules_importable(self):
        """All Phase 6 scoring modules should be importable."""
        from scripts.scoring.data_cleaner import DataCleaner
        from scripts.scoring.data_normalizer import DataNormalizer
        from scripts.scoring.scoring_engine import ScoringPipeline
        from scripts.scoring.context_builder import ContextBuilder
        from scripts.scoring.ai_analyst import AIAnalyst

        assert DataCleaner is not None
        assert DataNormalizer is not None
        assert ScoringPipeline is not None
        assert ContextBuilder is not None
        assert AIAnalyst is not None

    def test_ai_analyst_provider_config(self):
        """AIAnalyst should accept provider and model configuration."""
        from scripts.scoring.ai_analyst import AIAnalyst
        analyst = AIAnalyst(provider="openai", model="gpt-5.3")
        assert analyst.provider_name == "openai"
        assert analyst.model_name == "gpt-5.3"

        analyst2 = AIAnalyst(provider="anthropic", model="claude-haiku-4-5-20251001")
        assert analyst2.provider_name == "anthropic"
        assert analyst2.model_name == "claude-haiku-4-5-20251001"
