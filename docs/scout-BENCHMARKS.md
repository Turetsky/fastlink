# FastLink Scout — benchmark numbers (keep)

All times = Gemini API latency, direct Generative Language API, `GEMINI_API_KEY`
(`AQ.` key in fastlink-secrets.txt). Measured by `researcher` teammate, 2026-05-31.

## Setup
- Digest: **150 interactive items** (realistic page scale), ~5 marked `inFrame:true`.
- Intent: "fill the Card number field with 4242 4242 4242 4242 and click Place order".
- Target embedded for correctness check: inFrame input "Card number" (i=77), button "Place order" (i=120).
- Correctness = planner picked the TRUSTED tier (fast_click_xy@cx,cy → fast_type) on the
  inFrame Card field AND trusted click on Place order.
- 3 runs each. One-shot prompt ≈ 11.9 KB / **5081 prompt-tokens**.

## One-shot (min / median ms · validJSON · correct)
| Config | min | median | valid | correct |
|---|---|---|---|---|
| 2.5-flash, thinkingBudget:0 | 906 | 1024 | 3/3 | 3/3 ✅ |
| 2.5-flash, NO thinkingConfig (thinking ON) | 2055 | 2075 | 3/3 | 3/3 (2× slower) |
| **2.5-flash-lite** | **641** | **700** | 3/3 | 3/3 ✅ **FASTEST** |
| 2.0-flash | — | — | — | 404 "no longer available to new users" |
| 2.0-flash-lite-001 | — | — | — | 404 same gate |

## Two-stage 2.5-flash (buildPageMap + overlayIntent)
| Stage | min | median | notes |
|---|---|---|---|
| COLD (A+B) | 1699 | 1715 | stage-A map = 4923 tok |
| WARM (B only, map cached) | 846 | 865 | warm stage-B = 2876 tok |

## Supplemental (newer models, all 3/3 valid+correct)
| Model | min | median | note |
|---|---|---|---|
| 2.5-flash-lite, thinkBudget:0 | 653 | 788 | budget0 ≈ no-op on lite |
| gemini-flash-lite-latest | 1103 | 1155 | |
| gemini-3.1-flash-lite | 1048 | 1213 | |
| gemini-3-flash-preview | 2088 | 2152 | |
| gemini-3.5-flash | 795 | 3880 | erratic |

## Conclusions
1. **2.0-flash / 2.0-lite are DEAD on this key** — generateContent 404s even though
   models.list shows them. The "2.0 is faster" path is gone.
2. **Fastest valid+correct = gemini-2.5-flash-lite one-shot (~700ms).** ~1.5× faster
   than 2.5-flash@budget0 (~1024ms), ~3× faster than 2.5-flash thinking-on (~2075ms).
3. **Two-stage WARM (865ms) does NOT beat one-shot flash-lite (700ms)** at 150-item
   scale — model speed dominates; the smaller cached prompt buys little, and two-stage
   adds a ~1.7s cold A-stage + staleness risk.
4. **Recommendation (researcher):** single combined call on **2.5-flash-lite**; keep
   prewarm-on-load only as an availability optimization; fallback tier =
   2.5-flash@budget0 (~1s) for hard/ambiguous pages. Change `GEMINI_MODEL` default
   2.5-flash → 2.5-flash-lite; collapse the per-intent call to one-shot.

## Status of adoption
- Numbers saved (this file). Refactor to one-shot flash-lite: PENDING — sequenced
  AFTER server-builder finishes the screenshot rung (both touch scout.js).

---

# Part 3 — Rigorous Gemini 3.5 Flash / 3.1 Flash-Lite vs 2.5 Flash-Lite

Settles the user's question about the newer models' marketing speed claims
("3.5 Flash up to 4× faster", "3.1 Flash-Lite ~2× output speed + faster TTFT").
Those are **output-throughput** claims; our scout workload is short-prompt +
short-output, so **time-to-first-token dominates, not throughput**. Tested both.
Bigger samples + monotonic `process.hrtime` timing (the earlier "3.5-flash erratic
795–3880ms" was a WSL `Date.now()` clock-sync glitch; with monotonic timing 3.5-flash
is *consistently* slow, sd 122ms). All on the 150-item plan task; vision on the
annotated 7-box PNG.

## 3a. Plan-task latency — 10 runs, non-streaming (ms)
| model | min | median | p90 | max | stddev | correct |
|---|---|---|---|---|---|---|
| **2.5-flash-lite** | **574** | **691** | **770** | 771 | 65 | 10/10 ✅ |
| 3.1-flash-lite | 1022 | 1086 | 1117 | 1147 | 39 | 10/10 |
| 3.5-flash | 3390 | 3505 | 3720 | 3774 | 122 | 10/10 |
| 2.5-flash@budget0 | 871 | 940 | 993 | 1084 | 63 | 10/10 |

## 3b. Time-to-first-token — SSE `streamGenerateContent?alt=sse`, 6 runs (ms)
*(the metric that actually matters for scout: short prompt, short JSON output)*
| model | TTFT min | TTFT median | TTFT p90 | total median | correct |
|---|---|---|---|---|---|
| **2.5-flash-lite** | **385** | **440** | **554** | 653 | 6/6 ✅ |
| 3.1-flash-lite | 595 | 692 | 917 | 1029 | 6/6 |
| 3.5-flash | 2846 | 3060 | 3136 | 3636 | 6/6 |
| 2.5-flash@budget0 | 587 | 659 | 744 | 947 | 6/6 |

## 3c. With thinking forcibly disabled (thinkingBudget:0, 6 runs) — newer models' best case
| model | min | median | max | correct |
|---|---|---|---|---|
| gemini-3.5-flash @budget0 | 1733 | 1820 | 1899 | 6/6 |
| gemini-3.1-flash-lite @budget0 | 1061 | 1092 | 1125 | 6/6 |

3.5-flash is a **reasoning model** — default thinking spends ~3s before the first
token (kills TTFT). Forcing thinkingBudget:0 nearly halves it (3505→1820ms) but it's
**still ~2.6× slower** than 2.5-flash-lite. 3.1-flash-lite barely thinks by default
(1086 vs 1092ms with/without budget0) and stays **~1.6× slower** than 2.5-flash-lite.

## 3d. Vision-locate (annotated PNG → box#, 5 targets × 3 runs)
| model | correct | latency min | median | p90 |
|---|---|---|---|---|
| **2.5-flash-lite** | 15/15 ✅ | **430** | **512** | **573** |
| 3.1-flash-lite | 15/15 ✅ | 847 | 1000 | 1124 |
| 3.5-flash | 15/15 ✅ | 1491 | 1671 | 2270 |

All three are perfectly accurate at numbered-box ID; newer models are **not** better
at this vision task, just slower. 2.5-flash-lite is again fastest.

## Part 3 conclusions
1. **(a) Text-plan latency + consistency winner = gemini-2.5-flash-lite**, decisively:
   median 691ms / TTFT 440ms, tight spread (sd 65). 3.1-flash-lite ~1.6× slower,
   3.5-flash ~5× slower (~2.6× even with thinking off). The marketing throughput
   claims do **not** transfer to our short-prompt/short-output workload — TTFT, which
   is what we feel, favors the older lite model.
2. **(b) Vision-locate winner = gemini-2.5-flash-lite** too: 15/15 accurate AND
   fastest (512ms median vs 1000 / 1671). Newer models add latency, not accuracy.
3. **No reason to adopt 3.5-flash or 3.1-flash-lite for scout.** Keep
   **gemini-2.5-flash-lite** for both the planner and the screenshot rung.
   (Re-evaluate only if a future task needs long-output generation, where the
   throughput claims would actually apply.)
