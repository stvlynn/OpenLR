# AI segmentation investigation

Date: 2026-11-05. Actual environment: Windows, Chrome 155 headless, AMD Ryzen 7 7840U (16 reported logical processors), ONNX Runtime Web 1.31.1 WASM CPU with one thread. No GPU performance is inferred. Implementation, rights and byte delivery are documented in [AI masks](../docs/ai-masks.md).

## Selection and taxonomy

`ai/candidates.json` records inspected model revisions, byte sizes and published labels. U²-NetP is a 4.575 MB Apache-2.0 salient-object model; OpenCV Zoo PPHumanSeg is a 6.164 MB Apache-2.0 person model with explicit directory/weight licensing. They answer different questions and are not relabeled as one generic semantic classifier.

The optional sky provider is Xenova's quantized Facebook DETR ResNet-50 panoptic ONNX, 44,483,407 bytes at `ea24b2d4e0bfae31f0a1299ba3fb892a2df064de`, inherited Apache-2.0 model terms. FP32/FP16 variants are 172,282,717 / 86,559,030 bytes; none are redundantly shipped. MIT sky-specific U²-Net candidates (175.997 / 88.085 MB) were assessed but not used for fake results. NVIDIA SegFormer's original non-commercial use restriction excluded it.

The Hugging Face configuration labels **157** `sky-other`, but that legacy table does not correctly describe the panoptic weight's original COCO category IDs. Using it gave no sky (selected-class probabilities about 10⁻⁹); this failure is preserved in `ai/benchmark-sky-legacy-label.json`. Original DETR training uses annotation `category_id` directly; the original COCO table gives **187 = sky-other-merged**, **1 = person**. The exact taxonomy is retained as `web/models/COCO-PANOPTIC-CATEGORIES.json`, from revision `7bb4655548f98f3fedc07bf37e9040a992b054b0`. Correct category 187 yields a real sky query with confidence 0.9991 on the SpaceX photo.

Independent sigmoid mask outputs also leaked onto objects because panoptic query masks compete spatially. That intermediate result is retained in `ai/benchmark-sky-sigmoid-ablation.json`. The implemented soft mask sums sky probabilities after per-pixel softmax over accepted nonempty queries, matching the original panoptic competition contract while keeping soft coverage rather than final hard argmax labels.

Primary sources: [DETR dataset adapter](https://github.com/facebookresearch/detr/blob/29901c51d7fe8712168b8d0d64351170bc0f83e0/datasets/coco_panoptic.py), [panoptic postprocessing](https://github.com/facebookresearch/detr/blob/29901c51d7fe8712168b8d0d64351170bc0f83e0/models/segmentation.py), [original COCO taxonomy](https://github.com/cocodataset/panopticapi/blob/7bb4655548f98f3fedc07bf37e9040a992b054b0/panoptic_coco_categories.json), [fixed Facebook model card](https://huggingface.co/facebook/detr-resnet-50-panoptic/tree/d53b52a799403a8867920f82c869e40732b47037), [fixed ONNX conversion](https://huggingface.co/Xenova/detr-resnet-50-panoptic/tree/ea24b2d4e0bfae31f0a1299ba3fb892a2df064de).

## Actual ablations

`scripts/benchmark-ai.mjs` writes `ai/benchmark.json`; `--sky-only` writes `ai/benchmark-sky.json`. These record load/preprocessing/inference time, output dimensions/query scores, overall coverage, and soft coverage in explicitly listed manual regions. Standard normalization is compared with omitting it; Sky additionally compares 320 and 512 short-edge inputs. No graph/weight changes are made.

On the NASA astronaut, standard-normalization interior-person scores were 0.99973 (U²-NetP) and 0.98111 (PPHumanSeg), background-region scores 0.000026 / 0.000133. Omitting normalization changed person scores to 0.98251 / 0.97661 and altered total coverage. These are confidence/coverage probes, not estimated accuracy or IoU. Subject includes the held helmet, while Person largely excludes it.

CPU timing varied with load: early warm U²-NetP was 1.274 s and a later pass 2.253 s; warm PPHumanSeg 52–54 ms. The earlier full run measured Sky at 2.595 s (320 short edge) / 6.386 s (512). Latest sky-only results are in the separate JSON. Load costs are reported separately; ordinary per-job Workers incur load again. These observations are machine/fixture-specific, not latency guarantees.

Qualitative results and manual probes expose fine-object/tower limitations. Region rectangles identify open sky and solid rocket/platform interiors; they are not exhaustive annotations. There is no dense ground truth, validation-set IoU, or cross-camera generalization claim. The production 320/640 resize policy balances the observed latency/coverage; larger input is not assumed to improve this quantized export.

![Actual model comparison](ai/qualitative.png)

The full figure originally recorded independent-sigmoid sky results; `ai/sky-qualitative.png` and `ai/benchmark-sky.json` contain the current panoptic competition result. This distinction keeps intermediate ablations separate from acceptance evidence.

## Acceptance

`tests/ai-mask.test.js` passed in Windows/Chrome with the real optional weight: soft sampling; CLI target validation; actual UI Person inference; local exposure pixel change/background unchanged; original bytes unchanged; restart persistence; Subject/Background complement through forced Worker-startup fallback; actual Sky category 187; and one model download followed by cache reuse after reload. Native MyGo readiness is tested separately by the root integration task.

Fixture sources/rights are in `tests/fixtures/ai/README.md`. No personal photograph or Adobe asset is used. Digests support observational provenance; they are not model-load gates.
