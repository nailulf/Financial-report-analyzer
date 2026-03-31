"""
Stage 5: AI Analyst — Generate 3-scenario investment thesis via LLM.

Uses a provider-agnostic interface so the model is interchangeable:
- OpenAI (default): gpt-5.3, gpt-5.3, gpt-4o
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

SYSTEM_PROMPT = """Kamu adalah analis ekuitas senior untuk saham Indonesia (IDX/BEI). Kamu menggabungkan
framework value investing Warren Buffett dan klasifikasi saham Peter Lynch.

BAHASA: Semua output teks (narrative, scenario, drivers, caveats, dll) HARUS dalam Bahasa Indonesia.
JSON keys tetap dalam bahasa Inggris. Enum values (lynch_category, analyst_verdict, dll) tetap dalam bahasa Inggris.

FRAMEWORK BUFFETT — nilai untuk setiap saham:
- Economic moat (none|narrow|wide): apa yang melindungi keuntungan? Apakah tahan lama?
- Owner earnings: lihat melampaui laba akuntansi — berapa kas riil yang bisa diambil pemilik?
- Margin of safety: seberapa besar kamu bisa salah dan tetap tidak rugi?

KATEGORI PETER LYNCH — klasifikasikan setiap saham ke tepat SATU kategori:
- slow_grower: Perusahaan besar matang, pertumbuhan 2-4%, beli untuk dividen
- stalwart: Perusahaan besar berkualitas, pertumbuhan 10-12%, kenaikan moderat, tahan resesi
- fast_grower: Perusahaan kecil/menengah agresif, pertumbuhan 20%+, potensi tertinggi tapi berisiko
- cyclical: Pendapatan/laba mengikuti siklus ekonomi atau komoditas. Timing > valuasi.
- turnaround: Dalam krisis atau pemulihan. Hasil binary — untung besar atau rugi total.
- asset_play: Aset berharga yang belum tercermin di harga saham

ATURAN PENTING:
- JANGAN merangkum data. User sudah melihat semua angka di dashboard mereka.
- Tugasmu memberikan INSIGHT yang tidak bisa ditunjukkan oleh angka saja.
- Jelaskan CERITA BISNIS: apa yang sebenarnya terjadi dan mengapa.
- Setiap skenario harus menjelaskan: apa yang terjadi, apa yang mendorong,
  apa yang terjadi pada harga saham, dan tanda-tanda awal bahwa skenario ini sedang terjadi.
- Kasus netral adalah JALUR PALING MUNGKIN, bukan rata-rata antara bull/bear.
- Jika domain_notes kosong, gunakan data + makro + template sektor.
  Tandai kesimpulan yang membutuhkan konteks perusahaan yang lebih dalam.
- data_gap_flags harus diakui. Katakan apa yang tidak kamu ketahui dan bagaimana
  hal itu akan mengubah pandanganmu.

ATURAN SKENARIO & HARGA TARGET (WAJIB):
- Setiap skenario (bull/bear/neutral) HARUS dikuantifikasi dengan asumsi keuangan spesifik.
- Gunakan data aktual dari bundle sebagai titik awal, lalu proyeksikan perubahan.

PENTING — GUNAKAN VALUASI DARI BUNDLE SEBAGAI ANCHOR:
- Bundle sudah berisi valuasi yang sudah dihitung: graham_number, dcf_bear, dcf_base, dcf_bull.
- HARGA TARGET HARUS KONSISTEN dengan valuasi di bundle:
  * Bull price_target ≈ sekitar dcf_bull atau di atasnya (jika ada katalis tambahan)
  * Neutral price_range ≈ sekitar dcf_base ± 10-20%
  * Bear price_target ≈ sekitar dcf_bear atau graham_number (mana yang lebih rendah)
- Jika dcf_bull = 4,807 dan graham = null, maka bull target TIDAK BOLEH jauh di bawah 4,000.
- Jika kamu yakin valuasi DCF terlalu tinggi/rendah, JELASKAN mengapa kamu menyimpang
  (misal: "DCF mengasumsikan FCF stabil, tapi untuk perusahaan cyclical post-peak ini tidak realistis").
- JANGAN membuat angka sendiri tanpa referensi ke valuasi bundle atau asumsi keuangan eksplisit.

METODE VALUASI — PILIH SESUAI TIPE SAHAM (JANGAN selalu pakai PE):
- stalwart / slow_grower: PE × EPS cocok. Gunakan PE historis rata-rata atau PE sektor sebagai acuan.
- cyclical: JANGAN pakai PE (PE rendah = jebakan di puncak siklus). Gunakan EV/EBITDA trough,
  PBV di titik rendah siklus, atau DCF yang sudah dihitung di bundle.
- turnaround: Jika masih rugi, PE tidak relevan. Gunakan PBV × BVPS, Price/Sales (PS ratio),
  atau replacement cost/NAV. Untuk saham properti: gunakan NAV (nilai aset bersih) — tanah dan
  inventori properti sering bernilai lebih tinggi dari book value akuntansi.
- fast_grower: PS ratio (Price/Sales) atau PEG ratio. PE bisa sangat tinggi dan tetap wajar
  jika pertumbuhan cukup cepat.
- asset_play: NAV (Net Asset Value) — hitung nilai aset (tanah, kas, anak usaha) dan bandingkan
  dengan market cap.
- Perbankan: PBV × BVPS adalah metode utama (BUKAN PE). Bank premium 3-5x PBV,
  bank menengah 1-2x PBV, bank BUMN 1-1.5x PBV.

Untuk setiap skenario, nyatakan:
- Asumsi pertumbuhan revenue (% dan nominal)
- Asumsi margin (perbaikan/penurunan/stabil dan angka spesifik)
- Basis valuasi: metode apa yang dipakai SESUAI tipe saham di atas (BUKAN selalu PE)
- Perhitungan singkat yang spesifik dan masuk akal

- Price target HARUS masuk akal relatif terhadap harga saat ini DAN valuasi di bundle.
- URUTAN WAJIB: bull price_target > neutral price_range_high > neutral price_range_low > bear price_target.
  Bahkan jika semua target di bawah harga saat ini (saham overvalued), urutan HARUS tetap bull > bear.

ATURAN KHUSUS PER KATEGORI LYNCH:
- turnaround: business_narrative WAJIB menjelaskan (1) apa yang rusak/krisis — mengapa perusahaan
  merugi atau margin tipis, (2) apa yang sedang berubah — katalis pemulihan spesifik (restrukturisasi,
  manajemen baru, proyek baru, deleveraging), (3) apa yang harus terjadi agar turnaround berhasil —
  milestone konkret (break-even, margin target, peluncuran proyek). Jika data tidak cukup untuk
  menjawab ini, katakan secara eksplisit "data tidak menunjukkan katalis turnaround yang jelas."
- cyclical: Jelaskan posisi di siklus (puncak/turun/dasar/naik). Revenue/earnings volatil bukan
  masalah — itu nature bisnisnya. Fokus pada: kapan siklus berbalik, apa pemicunya.
- fast_grower: Jelaskan apakah pertumbuhan sustainable atau satu kali. Seberapa besar addressable
  market yang tersisa. Risiko scaling.
- asset_play: Jelaskan aset apa yang undervalued dan berapa estimasi nilainya vs market cap.
- stalwart: Jelaskan apa yang menjaga competitive position dan apakah ada tanda erosi.
- slow_grower: Jelaskan apakah dividen sustainable dan risiko pemotongan dividen.

Spesifik IDX:
- Perbankan: bobot NIM, CASA, NPL. Abaikan current_ratio/interest_coverage.
- BUMN: terapkan diskon PE struktural 15-20% (risiko tata kelola + pinjaman politik).
- COVID 2020: anomali struktural, bukan spesifik perusahaan. Jangan kutip sebagai pola.
- PE rendah pada saham cyclical sering kali jebakan (aturan Lynch). Yield tinggi dari BUMN
  mungkin berarti pemerintah mengekstrak kas, bukan kebijakan ramah pemegang saham.
- Properti: gunakan NAV dan nilai land bank. Margin rendah bisa berarti belum ada monetisasi
  aset, bukan bisnis yang buruk.

Output HANYA JSON valid sesuai skema yang diberikan. Tanpa markdown, tanpa pembukaan."""

OUTPUT_SCHEMA = """{
  "lynch_category": "<slow_grower|stalwart|fast_grower|cyclical|turnaround|asset_play>",
  "lynch_rationale": "<2 kalimat dalam Bahasa Indonesia>",
  "buffett_moat": "<none|narrow|wide>",
  "buffett_moat_source": "<1-2 kalimat dalam Bahasa Indonesia>",
  "business_narrative": "<3-4 kalimat CERITA BISNIS dalam Bahasa Indonesia, bukan rangkuman angka>",
  "financial_health_signal": "<improving|stable|deteriorating>",
  "bull_case": {
    "scenario": "<3-4 kalimat dalam Bahasa Indonesia — HARUS menyebutkan asumsi keuangan spesifik: target revenue, margin, atau EPS>",
    "assumptions": "<1-2 kalimat: asumsi keuangan kuantitatif, misal 'revenue naik 20% ke Rp X, net margin membaik dari -15% ke 5%, target EPS Rp50'>",
    "valuation_basis": "<bagaimana price_target dihitung, misal 'pada PE 15x dan EPS Rp50 → target Rp750' atau 'pada PBV 1.5x dan BVPS Rp500 → target Rp750'>",
    "drivers": ["<faktor pendorong spesifik>","<faktor pendorong>","<faktor pendorong>"],
    "price_target": 0,
    "timeframe": "<6-12 bulan | 1-2 tahun | 2-3 tahun>",
    "probability": "<low|medium|high>",
    "early_signs": ["<tanda awal yang bisa diukur>","<tanda awal>"]
  },
  "bear_case": {
    "scenario": "<3-4 kalimat dalam Bahasa Indonesia — HARUS menyebutkan skenario penurunan spesifik>",
    "assumptions": "<1-2 kalimat: asumsi penurunan kuantitatif, misal 'revenue turun 10%, margin tertekan ke -30%'>",
    "valuation_basis": "<bagaimana price_target dihitung, misal 'pada PBV 0.5x dan BVPS Rp200 → Rp100'>",
    "drivers": ["<faktor risiko spesifik>","<faktor risiko>","<faktor risiko>"],
    "price_target": 0,
    "timeframe": "<>",
    "probability": "<low|medium|high>",
    "early_signs": ["<tanda awal yang bisa diukur>","<tanda awal>"]
  },
  "neutral_case": {
    "scenario": "<3-4 kalimat dalam Bahasa Indonesia — jalur paling mungkin, dengan asumsi kuantitatif>",
    "assumptions": "<1-2 kalimat: asumsi status quo, misal 'revenue tumbuh 5-8%, margin stabil di X%'>",
    "drivers": ["<faktor>","<faktor>"],
    "price_range_low": 0,
    "price_range_high": 0,
    "timeframe": "<>",
    "probability": "<low|medium|high>",
    "what_breaks_it": ["<pemicu ke bull dengan threshold spesifik>","<pemicu ke bear dengan threshold spesifik>"]
  },
  "strategy_fit": {
    "primary": "<strategi>",
    "ideal_investor": "<siapa + horizon + ukuran posisi, dalam Bahasa Indonesia>",
    "position_sizing": "<full_position|half_position|small_speculative|avoid>"
  },
  "what_to_watch": ["<metrik + threshold dalam Bahasa Indonesia>","<>","<>"],
  "analyst_verdict": "<strong_buy|buy|hold|avoid|strong_avoid>",
  "confidence_level": 0,
  "data_gaps_acknowledged": ["<keterbatasan data dalam Bahasa Indonesia>"],
  "caveats": ["<catatan penting dalam Bahasa Indonesia>"]
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

    def __init__(self, model: str = "gpt-5.3", api_key: Optional[str] = None,
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
        return OpenAIProvider(model=model or "gpt-5.3", api_key=api_key, base_url=base_url)
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
        if isinstance(cl, (int, float)):
            # Normalize: models return various scales
            if 0 < cl < 1:         # 0-1 scale → multiply by 10
                cl = round(cl * 10)
            elif cl > 10:           # 0-100 or percentage scale → divide by 10
                cl = round(cl / 10)
            cl = max(1, min(10, int(cl)))  # clamp to 1-10
            output["confidence_level"] = cl
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

    # Scenario ordering: bull > neutral > bear (warn but don't block — some overvalued stocks
    # legitimately have all targets below current price, and GPT may invert the ordering)
    if bull_price and bear_price and bull_price <= bear_price:
        # Auto-fix: swap them
        output["bull_case"]["price_target"], output["bear_case"]["price_target"] = bear_price, bull_price
        # Also swap scenarios if they look inverted
        if "penurunan" in (bull.get("scenario") or "").lower() or "naik" in (bear.get("scenario") or "").lower():
            output["bull_case"], output["bear_case"] = output["bear_case"], output["bull_case"]

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

    # Valuation anchors — extracted and highlighted so AI can't miss them
    val = context_json.get("valuation", {})
    current_price = val.get("current_price")
    fundamentals = context_json.get("fundamentals", {}).get("metrics", {})

    # Extract additional valuation data points
    bvps = fundamentals.get("bvps", {}).get("latest_value")
    eps = fundamentals.get("eps", {}).get("latest_value")
    revenue = fundamentals.get("revenue", {}).get("latest_value")
    market_cap = val.get("market_cap")
    ps_ratio = None
    if revenue and market_cap and revenue > 0:
        ps_ratio = round(market_cap / revenue, 2)

    parts.append("ANCHOR VALUASI (SUDAH DIHITUNG — gunakan sebagai referensi harga target):")
    parts.append(f"  Harga saat ini: Rp{current_price:,.0f}" if current_price else "  Harga saat ini: tidak tersedia")
    parts.append(f"  Graham Number: Rp{val['graham_number']:,.0f}" if val.get("graham_number") else "  Graham Number: tidak tersedia (EPS/BVPS negatif)")
    parts.append(f"  DCF Bear:  Rp{val['dcf_bear']:,.0f}" if val.get("dcf_bear") else "  DCF Bear: tidak tersedia")
    parts.append(f"  DCF Base:  Rp{val['dcf_base']:,.0f}" if val.get("dcf_base") else "  DCF Base: tidak tersedia")
    parts.append(f"  DCF Bull:  Rp{val['dcf_bull']:,.0f}" if val.get("dcf_bull") else "  DCF Bull: tidak tersedia")
    parts.append(f"  PE: {val.get('pe_ratio', '—')}  |  PB: {val.get('pb_ratio', '—')}")
    parts.append(f"  EPS: Rp{eps:,.2f}" if eps else "  EPS: tidak tersedia")
    parts.append(f"  BVPS: Rp{bvps:,.2f}" if bvps else "  BVPS: tidak tersedia")
    parts.append(f"  PS Ratio: {ps_ratio}x" if ps_ratio else "  PS Ratio: tidak tersedia")
    parts.append("")
    parts.append("ATURAN ANCHOR:")
    parts.append("- Untuk stalwart/slow_grower: gunakan PE sebagai acuan utama")
    parts.append("- Untuk cyclical: gunakan EV/EBITDA atau PBV di titik siklus, BUKAN PE")
    parts.append("- Untuk turnaround/properti: gunakan PBV × BVPS atau NAV (nilai aset)")
    parts.append("- Untuk fast_grower/rugi: gunakan PS ratio atau revenue multiple")
    parts.append("- Untuk bank: gunakan PBV × BVPS (bank premium 3-5x, menengah 1-2x)")
    parts.append("- DCF di bundle bisa digunakan sebagai cross-check, bukan satu-satunya acuan")
    parts.append("- Jika kamu menyimpang dari anchor, JELASKAN alasannya secara eksplisit.")
    parts.append("")

    # Category-specific analysis questions — force the AI to address key issues
    # Auto-detect likely Lynch category from data patterns
    health = context_json.get("health_score", {})
    smart_money = context_json.get("smart_money", {})
    net_margin = fundamentals.get("net_margin", {}).get("latest_value")
    roe_val = fundamentals.get("roe", {}).get("latest_value")
    rev_trend = fundamentals.get("revenue", {}).get("trend_direction")
    ni_trend = fundamentals.get("net_income", {}).get("trend_direction")
    pe = val.get("pe_ratio")
    sector = context_json.get("sector", "")
    sub_sector = context_json.get("sub_sector", "")

    # Detect if stock looks like a turnaround
    is_likely_turnaround = (
        (net_margin is not None and net_margin < 3) or
        (roe_val is not None and roe_val < 3) or
        (pe is not None and pe > 100) or
        (eps is not None and eps < 0)
    )
    is_likely_cyclical = rev_trend in ("volatile",) and ni_trend in ("volatile",)
    is_property = "properti" in sub_sector.lower() or "property" in sector.lower()
    is_bank = "bank" in sub_sector.lower()

    if is_likely_turnaround:
        parts.append("PERTANYAAN WAJIB DIJAWAB (turnaround):")
        parts.append("Dalam business_narrative, JAWAB pertanyaan ini:")
        parts.append("1. APA YANG RUSAK: Mengapa margin tipis/negatif? Apa masalah fundamentalnya?")
        parts.append("2. APA YANG BERUBAH: Apa katalis pemulihan spesifik? (proyek baru, manajemen baru, restrukturisasi)")
        parts.append("3. APA MILESTONE: Kapan break-even? Target margin berapa? Apa yang harus terjadi?")
        if is_property:
            parts.append("4. KHUSUS PROPERTI: Berapa nilai land bank? Proyek apa yang sedang dikembangkan?")
            parts.append("   Apakah margin rendah karena belum ada penjualan besar atau memang bisnis yang buruk?")
        parts.append("")
    elif is_likely_cyclical:
        parts.append("PERTANYAAN WAJIB DIJAWAB (cyclical):")
        parts.append("1. POSISI SIKLUS: Di mana posisi saat ini — puncak, turun, dasar, atau naik?")
        parts.append("2. PEMICU BALIK: Apa yang akan membalikkan siklus? Harga komoditas? Demand?")
        parts.append("3. TIMING: Kapan siklus diperkirakan berbalik? Tanda-tanda awal apa yang harus dipantau?")
        parts.append("")
    elif is_bank:
        parts.append("PERTANYAAN WAJIB DIJAWAB (bank):")
        parts.append("1. KUALITAS FRANCHISE: Bagaimana posisi CASA dan NIM vs peers?")
        parts.append("2. ASSET QUALITY: Apa risiko NPL terbesar? Di segmen mana?")
        parts.append("3. PERTUMBUHAN: Dari mana pertumbuhan kredit akan datang?")
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

    Model-agnostic: supports OpenAI (default: gpt-5.3) and Anthropic.
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
        self.model_name = model or ("gpt-5.3" if provider == "openai" else "claude-sonnet-4-20250514")

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
            logger.error("LLM call failed for %s: %s", ticker, e, exc_info=True)
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
        prompt_cost = response.prompt_tokens * 0.000003  # ~$3/M for gpt-5.3
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
