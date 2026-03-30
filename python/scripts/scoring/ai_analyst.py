"""
Stage 5: AI Analyst — Generate 3-scenario investment thesis via LLM.

Uses a provider-agnostic interface so the model is interchangeable:
- OpenAI (default): gpt-4o-nano, gpt-4o-mini, gpt-4o
- Anthropic: claude-sonnet-4-20250514, etc.

Single enriched call per ticker with 3-layer context injection
(macro + sector template + domain notes).

FRD reference: Section 6 (AI Analyst Module)
"""

from __future__ import annotations

import json
import logging
import os
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from scripts.scoring.schema import AIAnalysisResult

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# System prompt (FRD §6.3)
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a senior equity analyst for Indonesian stocks (IDX/BEI). You combine
Warren Buffett's value investing framework and Peter Lynch's stock classification.

BUFFETT FRAMEWORK — assess for every stock:
- Economic moat (none|narrow|wide): what protects profits? Is it durable?
- Owner earnings: look past accounting — what cash can the owner actually take out?
- Margin of safety: how much can you be wrong and still not lose money?

PETER LYNCH CATEGORIES — classify every stock into exactly ONE:
- slow_grower: Large mature, 2-4% growth, buy for dividends
- stalwart: Large quality, 10-12% growth, moderate upside, recession-resistant
- fast_grower: Small/mid aggressive, 20%+ growth, highest upside but risky
- cyclical: Revenue/profits follow economic or commodity cycles. Timing > valuation.
- turnaround: In crisis or recovering. Binary outcome.
- asset_play: Valuable assets the market hasn't noticed

CRITICAL RULES:
- Do NOT summarize the data. The user already sees every number on their dashboard.
- Your job is to provide INSIGHT that the numbers alone cannot show.
- Explain the BUSINESS STORY: what is actually happening and why.
- Each scenario must explain: what happens, what drives it, what the stock does,
  and the early signs that this scenario is playing out.
- The neutral case is the MOST LIKELY path, not a blend of bull/bear.
- If domain_notes are empty, work with data + macro + sector template.
  Flag conclusions that would benefit from deeper company-specific knowledge.
- data_gap_flags must be acknowledged. Say what you don't know and how it
  would change your view.

IDX-specific:
- Banking: weight NIM, CASA, NPL. Ignore current_ratio/interest_coverage.
- BUMN: apply 15-20% structural PE discount (governance + political lending risk).
- COVID 2020: structural anomaly, not company-specific. Do not cite as pattern.
- Low PE on cyclicals is often a trap (Lynch rule). High yield from BUMN may be
  government extracting cash, not shareholder-friendly policy.

Output ONLY valid JSON matching the schema provided. No markdown, no preamble."""

OUTPUT_SCHEMA = """{
  "lynch_category": "<slow_grower|stalwart|fast_grower|cyclical|turnaround|asset_play>",
  "lynch_rationale": "<2 sentences>",
  "buffett_moat": "<none|narrow|wide>",
  "buffett_moat_source": "<1-2 sentences>",
  "business_narrative": "<3-4 sentences — the STORY, not the numbers>",
  "financial_health_signal": "<improving|stable|deteriorating>",
  "bull_case": {
    "scenario": "<3-4 sentences>",
    "drivers": ["<>","<>","<>"],
    "price_target": 0,
    "timeframe": "<6-12m | 1-2y | 2-3y>",
    "probability": "<low|medium|high>",
    "early_signs": ["<>","<>"]
  },
  "bear_case": {
    "scenario": "<3-4 sentences>",
    "drivers": ["<>","<>","<>"],
    "price_target": 0,
    "timeframe": "<>",
    "probability": "<low|medium|high>",
    "early_signs": ["<>","<>"]
  },
  "neutral_case": {
    "scenario": "<3-4 sentences>",
    "drivers": ["<>","<>"],
    "price_range_low": 0,
    "price_range_high": 0,
    "timeframe": "<>",
    "probability": "<low|medium|high>",
    "what_breaks_it": ["<to bull>","<to bear>"]
  },
  "strategy_fit": {
    "primary": "<strategy>",
    "ideal_investor": "<who + horizon + sizing>",
    "position_sizing": "<full_position|half_position|small_speculative|avoid>"
  },
  "what_to_watch": ["<metric+threshold>","<>","<>"],
  "analyst_verdict": "<strong_buy|buy|hold|avoid|strong_avoid>",
  "confidence_level": 0,
  "data_gaps_acknowledged": ["<>"],
  "caveats": ["<>"]
}"""


# ---------------------------------------------------------------------------
# Provider abstraction
# ---------------------------------------------------------------------------

@dataclass
class LLMResponse:
    content: str
    prompt_tokens: int = 0
    output_tokens: int = 0
    model: str = ""


class LLMProvider(ABC):
    """Abstract base for LLM providers."""

    @abstractmethod
    def chat(self, system: str, user: str) -> LLMResponse:
        ...


class OpenAIProvider(LLMProvider):
    """OpenAI-compatible provider (works with OpenAI, Azure, local proxies)."""

    def __init__(self, model: str = "gpt-4o-nano", api_key: Optional[str] = None,
                 base_url: Optional[str] = None):
        self.model = model
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY")
        self.base_url = base_url
        self._client = None

    def _get_client(self):
        if self._client is None:
            from openai import OpenAI
            kwargs = {"api_key": self.api_key}
            if self.base_url:
                kwargs["base_url"] = self.base_url
            self._client = OpenAI(**kwargs)
        return self._client

    def chat(self, system: str, user: str) -> LLMResponse:
        client = self._get_client()
        response = client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.3,
            response_format={"type": "json_object"},
        )
        choice = response.choices[0]
        usage = response.usage
        return LLMResponse(
            content=choice.message.content or "",
            prompt_tokens=usage.prompt_tokens if usage else 0,
            output_tokens=usage.completion_tokens if usage else 0,
            model=response.model or self.model,
        )


class AnthropicProvider(LLMProvider):
    """Anthropic Claude provider."""

    def __init__(self, model: str = "claude-sonnet-4-20250514", api_key: Optional[str] = None):
        self.model = model
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        self._client = None

    def _get_client(self):
        if self._client is None:
            from anthropic import Anthropic
            self._client = Anthropic(api_key=self.api_key)
        return self._client

    def chat(self, system: str, user: str) -> LLMResponse:
        client = self._get_client()
        response = client.messages.create(
            model=self.model,
            max_tokens=4096,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        content = response.content[0].text if response.content else ""
        return LLMResponse(
            content=content,
            prompt_tokens=response.usage.input_tokens if response.usage else 0,
            output_tokens=response.usage.output_tokens if response.usage else 0,
            model=self.model,
        )


def get_provider(
    provider: str = "openai",
    model: Optional[str] = None,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
) -> LLMProvider:
    """Factory: create the appropriate LLM provider."""
    if provider == "openai":
        return OpenAIProvider(model=model or "gpt-4o-nano", api_key=api_key, base_url=base_url)
    elif provider == "anthropic":
        return AnthropicProvider(model=model or "claude-sonnet-4-20250514", api_key=api_key)
    else:
        raise ValueError(f"Unknown provider: {provider}. Use 'openai' or 'anthropic'.")


# ---------------------------------------------------------------------------
# Output validation (FRD §6.5)
# ---------------------------------------------------------------------------

VALID_LYNCH = {"slow_grower", "stalwart", "fast_grower", "cyclical", "turnaround", "asset_play"}
VALID_VERDICT = {"strong_buy", "buy", "hold", "avoid", "strong_avoid"}
VALID_HEALTH = {"improving", "stable", "deteriorating"}


def validate_output(
    output: dict,
    current_price: Optional[float] = None,
    data_gap_flags: Optional[List[str]] = None,
    reliability_grade: Optional[str] = None,
) -> List[str]:
    """
    Validate AI output against structural, consistency, and quality rules.
    Returns list of validation errors (empty = valid).
    """
    errors = []

    # ── Structural checks ────────────────────────────────────
    required_fields = [
        "lynch_category", "buffett_moat", "analyst_verdict",
        "confidence_level", "bull_case", "bear_case", "neutral_case",
        "business_narrative", "strategy_fit", "what_to_watch",
    ]
    for field in required_fields:
        if field not in output:
            errors.append(f"missing_field: {field}")

    if output.get("lynch_category") and output["lynch_category"] not in VALID_LYNCH:
        errors.append(f"invalid_lynch_category: {output['lynch_category']}")

    if output.get("analyst_verdict") and output["analyst_verdict"] not in VALID_VERDICT:
        errors.append(f"invalid_analyst_verdict: {output['analyst_verdict']}")

    if output.get("financial_health_signal") and output["financial_health_signal"] not in VALID_HEALTH:
        errors.append(f"invalid_health_signal: {output['financial_health_signal']}")

    cl = output.get("confidence_level")
    if cl is not None:
        # Normalize: some models return 0.7 (0-1 scale) instead of 7 (1-10 scale)
        if isinstance(cl, (int, float)) and 0 < cl < 1:
            output["confidence_level"] = round(cl * 10)
            cl = output["confidence_level"]
        if not isinstance(cl, (int, float)) or cl < 1 or cl > 10:
            errors.append(f"confidence_level_out_of_range: {cl}")

    # ── Scenario consistency ─────────────────────────────────
    bull = output.get("bull_case", {})
    bear = output.get("bear_case", {})
    neutral = output.get("neutral_case", {})

    bull_price = bull.get("price_target")
    bear_price = bear.get("price_target")
    neutral_high = neutral.get("price_range_high")
    neutral_low = neutral.get("price_range_low")

    if bull_price and bear_price and bull_price <= bear_price:
        errors.append(f"scenario_ordering: bull ({bull_price}) should exceed bear ({bear_price})")

    if neutral_low and neutral_high and neutral_low >= neutral_high:
        errors.append(f"neutral_range_inverted: low ({neutral_low}) >= high ({neutral_high})")

    # Price sanity (within 5x of current price)
    if current_price and current_price > 0:
        for label, price in [("bull", bull_price), ("bear", bear_price)]:
            if price and (price > current_price * 5 or price < current_price * 0.05):
                errors.append(f"{label}_price_unrealistic: {price} vs current {current_price}")

    # ── Data quality alignment ───────────────────────────────
    if data_gap_flags and len(data_gap_flags) > 0:
        ack = output.get("data_gaps_acknowledged", [])
        if not ack or len(ack) == 0:
            errors.append("data_gaps_not_acknowledged: context has gaps but output has no acknowledgement")

    if reliability_grade in ("C", "D", "F"):
        if cl and cl > 7:
            errors.append(f"confidence_too_high_for_reliability: confidence_level={cl} but reliability={reliability_grade}")

    # At least one caveat
    caveats = output.get("caveats", [])
    if not caveats or len(caveats) == 0:
        errors.append("no_caveats: at least 1 caveat required")

    return errors


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

def build_user_prompt(
    context_json: dict,
    sector_template: Optional[dict] = None,
    macro_context: Optional[dict] = None,
    domain_notes: Optional[str] = None,
) -> str:
    """Assemble the user prompt from context bundle + layers."""
    parts = []

    # Macro context
    if macro_context:
        parts.append(f"MACRO CONTEXT ({macro_context.get('as_of', 'current')}):")
        parts.append(f"  BI rate: {macro_context.get('bi_rate')}% ({macro_context.get('bi_rate_direction', 'unknown')})")
        parts.append(f"  IDR: {macro_context.get('usd_idr')}/USD ({macro_context.get('idr_trend', '')})")
        parts.append(f"  IDX YTD: {macro_context.get('idx_composite_ytd')}%")
        parts.append(f"  Foreign flow: {macro_context.get('foreign_flow_regime', 'unknown')}")
        if macro_context.get("foreign_flow_note"):
            parts.append(f"  Note: {macro_context['foreign_flow_note']}")
        parts.append("")

    # Sector template
    if sector_template:
        parts.append(f"SECTOR TEMPLATE ({sector_template.get('subsector', 'unknown')}):")
        if sector_template.get("key_metrics"):
            parts.append(f"  Key metrics: {sector_template['key_metrics']}")
        if sector_template.get("valuation_method"):
            parts.append(f"  Valuation: {sector_template['valuation_method']}")
        if sector_template.get("current_dynamics"):
            parts.append(f"  Dynamics: {sector_template['current_dynamics']}")
        if sector_template.get("common_risks"):
            parts.append(f"  Risks: {sector_template['common_risks']}")
        if sector_template.get("exemptions"):
            parts.append(f"  Exemptions: {sector_template['exemptions']}")
        parts.append("")

    # Domain notes
    if domain_notes:
        parts.append(f"DOMAIN CONTEXT (user-provided):")
        parts.append(f"  {domain_notes}")
        parts.append("")
    else:
        parts.append("DOMAIN CONTEXT: None available. Base analysis on data + macro + sector template only.")
        parts.append("Flag conclusions that would benefit from deeper company-specific knowledge.")
        parts.append("")

    # Data bundle
    parts.append("STOCK DATA BUNDLE:")
    parts.append(json.dumps(context_json, indent=2, default=str))
    parts.append("")

    # Output instruction
    parts.append("Respond with ONLY the following JSON schema:")
    parts.append(OUTPUT_SCHEMA)

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Main analyst class
# ---------------------------------------------------------------------------

class AIAnalyst:
    """
    Generate 3-scenario investment thesis via LLM.

    Model-agnostic: supports OpenAI (default: gpt-4o-nano) and Anthropic.
    """

    def __init__(
        self,
        provider: str = "openai",
        model: Optional[str] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
    ):
        self.llm = get_provider(provider, model, api_key, base_url)
        self.provider_name = provider
        self.model_name = model or ("gpt-4o-nano" if provider == "openai" else "claude-sonnet-4-20250514")

    def analyze(
        self,
        context_bundle: dict,
        current_price: Optional[float] = None,
        data_gap_flags: Optional[List[str]] = None,
        reliability_grade: Optional[str] = None,
        sector_template: Optional[dict] = None,
        domain_notes: Optional[str] = None,
        retry: bool = True,
    ) -> AIAnalysisResult:
        """
        Run single enriched LLM call for one ticker.

        Args:
            context_bundle: The full context JSON from ai_context_cache
            current_price: Latest stock price (for validation)
            data_gap_flags: From stock_scores (for validation)
            reliability_grade: From stock_scores (for validation)
            sector_template: From sector_templates table
            domain_notes: From stock_notes table
            retry: If True, retry once on validation failure

        Returns:
            AIAnalysisResult
        """
        ticker = context_bundle.get("ticker", "UNKNOWN")
        start = time.time()

        # Build macro context from bundle or load fresh
        macro = context_bundle.get("macro_context")

        # Build prompt
        user_prompt = build_user_prompt(
            context_json=context_bundle,
            sector_template=sector_template,
            macro_context=macro,
            domain_notes=domain_notes,
        )

        # Call LLM
        try:
            response = self.llm.chat(SYSTEM_PROMPT, user_prompt)
        except Exception as e:
            logger.error("LLM call failed for %s: %s", ticker, e)
            return AIAnalysisResult(
                ticker=ticker, success=False,
                error=f"LLM call failed: {str(e)}"
            )

        # Parse JSON
        try:
            # Strip markdown code fences if present
            content = response.content.strip()
            if content.startswith("```"):
                content = content.split("\n", 1)[1] if "\n" in content else content[3:]
                if content.endswith("```"):
                    content = content[:-3]
                content = content.strip()

            output = json.loads(content)
        except json.JSONDecodeError as e:
            logger.error("JSON parse failed for %s: %s", ticker, e)
            return AIAnalysisResult(
                ticker=ticker, success=False,
                error=f"JSON parse failed: {str(e)}",
                prompt_tokens=response.prompt_tokens,
                output_tokens=response.output_tokens,
            )

        # Validate
        validation_errors = validate_output(
            output,
            current_price=current_price,
            data_gap_flags=data_gap_flags,
            reliability_grade=reliability_grade,
        )

        if validation_errors:
            logger.warning("Validation errors for %s: %s", ticker, validation_errors)
            if retry:
                logger.info("Retrying %s...", ticker)
                return self.analyze(
                    context_bundle, current_price, data_gap_flags,
                    reliability_grade, sector_template, domain_notes,
                    retry=False,
                )
            return AIAnalysisResult(
                ticker=ticker, success=False,
                error=f"Validation failed: {validation_errors}",
                prompt_tokens=response.prompt_tokens,
                output_tokens=response.output_tokens,
            )

        # Estimate cost
        prompt_cost = response.prompt_tokens * 0.000003  # ~$3/M for gpt-4o-nano
        output_cost = response.output_tokens * 0.000015
        cost = prompt_cost + output_cost

        duration = time.time() - start
        logger.info(
            "%s analysis complete: verdict=%s confidence=%s cost=$%.4f (%.1fs)",
            ticker, output.get("analyst_verdict"), output.get("confidence_level"),
            cost, duration,
        )

        return AIAnalysisResult(
            ticker=ticker,
            success=True,
            lynch_category=output.get("lynch_category"),
            buffett_moat=output.get("buffett_moat"),
            analyst_verdict=output.get("analyst_verdict"),
            confidence_level=output.get("confidence_level"),
            bull_case=output.get("bull_case"),
            bear_case=output.get("bear_case"),
            neutral_case=output.get("neutral_case"),
            prompt_tokens=response.prompt_tokens,
            output_tokens=response.output_tokens,
            cost_usd_estimate=cost,
        )

    def analyze_batch(
        self,
        bundles: List[dict],
        delay_between: float = 2.0,
        **kwargs,
    ) -> List[AIAnalysisResult]:
        """Batch analysis with rate limiting."""
        results = []
        for i, bundle in enumerate(bundles):
            result = self.analyze(bundle, **kwargs)
            results.append(result)
            if i < len(bundles) - 1:
                time.sleep(delay_between)
        return results
