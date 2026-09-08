#!/usr/bin/env python3
"""Optional, offline image-reranking experiment. Never used by the montage runtime.

Python 3.9+; --metrics-only needs only the standard library. Images, model weights,
and optional dependencies must already exist locally. Nothing is downloaded.
"""
import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import sys
import time

JSON_LIMIT = 2 * 1024 * 1024
IMAGE_LIMIT = 10 * 1024 * 1024
TOTAL_IMAGE_LIMIT = 200 * 1024 * 1024
MODEL_LIMIT = 3 * 1024 * 1024 * 1024
MODEL_FILES = {
    "open_clip_config.json", "open_clip_model.safetensors", "README.md",
    "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json",
}
METHODS = ("providerOrder", "siglipRu", "siglipEn", "siglipBilingualMean")


class BenchmarkError(Exception):
    pass


class MissingDependencies(BenchmarkError):
    pass


def require(condition, message):
    if not condition:
        raise BenchmarkError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON property")
        result[key] = value
    return result


def reject_constant(value):
    raise BenchmarkError("non-finite JSON number")


def load_json(path, role):
    try:
        with Path(path).open("rb") as stream:
            raw = stream.read(JSON_LIMIT + 1)
        require(len(raw) <= JSON_LIMIT, role + " exceeds JSON size limit")
        value = json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
        require(isinstance(value, dict), role + " must be an object")
        return value, digest(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise BenchmarkError("cannot read valid " + role + " JSON") from error


def valid_id(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) is not None


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def positive_int(value, upper):
    return type(value) is int and 0 < value <= upper


def relative_name(value):
    require(isinstance(value, str) and len(value) <= 240 and
            re.fullmatch(r"[A-Za-z0-9_./-]+", value) is not None,
            "invalid relative image path")
    parts = value.split("/")
    require(not PurePosixPath(value).is_absolute() and
            all(part not in ("", ".", "..") for part in parts),
            "invalid relative image path")
    return value


def local_file(root, name):
    candidate = (root / relative_name(name)).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as error:
        raise BenchmarkError("local file escapes its root") from error
    require(candidate.is_file(), "required local file is missing")
    return candidate


def load_evidence(corpus_path, labels_path, map_path):
    corpus, corpus_hash = load_json(corpus_path, "corpus")
    labels, labels_hash = load_json(labels_path, "labels")
    blind_map, map_hash = load_json(map_path, "blind map")
    bindings = corpus.get("bindings", {})
    require(isinstance(bindings, dict), "corpus bindings must be an object")
    require(bindings.get("labelsSha256") == labels_hash, "labels hash mismatch")
    require(bindings.get("blindMapSha256") == map_hash, "blind map hash mismatch")
    require(type(corpus.get("schemaVersion")) is int and corpus["schemaVersion"] == 1,
            "unsupported corpus schema version")
    queries = corpus.get("queries")
    require(isinstance(queries, list) and 1 <= len(queries) <= 100,
            "queries must contain 1 to 100 entries")
    require(type(labels.get("relevantThreshold")) is int and labels["relevantThreshold"] == 2,
            "relevantThreshold must be 2 for this 0-3 experiment")
    require(isinstance(labels.get("grades"), dict), "labels must contain grades")
    query_ids, total = set(), 0
    prepared = []
    for query in queries:
        require(isinstance(query, dict) and valid_id(query.get("id")), "invalid query id")
        qid = query["id"]
        require(qid not in query_ids, "duplicate query id")
        query_ids.add(qid)
        for language in ("ru", "en"):
            text = query.get(language)
            require(isinstance(text, str) and 0 < len(text.strip()) <= 2000, "invalid query text")
        entries = query.get("candidates")
        require(isinstance(entries, list) and 1 <= len(entries) <= 80,
                "query candidates must contain 1 to 80 entries")
        total += len(entries)
        require(total <= 1000, "corpus exceeds 1000 candidates")
        seen, ranks, usable = set(), [], []
        for entry in entries:
            require(isinstance(entry, dict) and valid_id(entry.get("id")), "invalid candidate id")
            require(entry["id"] not in seen, "duplicate candidate id")
            seen.add(entry["id"])
            require(positive_int(entry.get("providerRank"), 10000), "invalid provider rank")
            ranks.append(entry["providerRank"])
            if "file" not in entry:
                require(isinstance(entry.get("excludedReason"), str) and
                        0 < len(entry["excludedReason"]) <= 256, "exclusion must have a reason")
                continue
            relative_name(entry["file"])
            require(valid_hash(entry.get("sha256")), "invalid image SHA-256")
            require(positive_int(entry.get("bytes"), IMAGE_LIMIT), "invalid image byte bound")
            usable.append(entry)
        require(ranks == sorted(set(ranks)), "provider ranks must be unique and ordered")
        require(len(usable) >= 5, "each query needs at least five usable candidates")
        mapping, grades = blind_map.get(qid), labels["grades"].get(qid)
        require(isinstance(mapping, dict) and isinstance(grades, dict) and
                set(mapping) == set(grades), "labels and blind map must match exactly")
        require(all(valid_id(tag) for tag in mapping), "invalid blind tag")
        ids = [entry["id"] for entry in usable]
        require(len(mapping) == len(ids) and all(valid_id(aid) for aid in mapping.values()) and
                len(set(mapping.values())) == len(ids) and set(mapping.values()) == set(ids),
                "blind map must cover every usable candidate exactly once")
        require(all(type(grade) is int and 0 <= grade <= 3 for grade in grades.values()),
                "grade must be an integer from 0 to 3")
        prepared.append({**query, "usable": usable,
                         "gradeById": {aid: grades[tag] for tag, aid in mapping.items()},
                         "tagById": {aid: tag for tag, aid in mapping.items()}})
    require(set(blind_map) == query_ids and set(labels["grades"]) == query_ids,
            "labels and blind map query sets must match corpus")
    hashes = {"corpusSha256": corpus_hash, "labelsSha256": labels_hash, "blindMapSha256": map_hash}
    return corpus, prepared, hashes


def load_scores(path, queries, hashes):
    saved, _ = load_json(path, "scores")
    require(type(saved.get("schemaVersion")) is int and saved["schemaVersion"] == 1,
            "unsupported score schema version")
    require(saved.get("inputHashes") == hashes, "score input hash mismatch")
    rows = saved.get("queries")
    require(isinstance(rows, list) and len(rows) == len(queries), "score queries must match corpus")
    by_query = {}
    for query in rows:
        require(isinstance(query, dict) and valid_id(query.get("id")) and
                query["id"] not in by_query, "invalid or duplicate score query")
        by_query[query.get("id")] = query
    require(set(by_query) == {q["id"] for q in queries}, "score queries must match corpus")
    result = {}
    for query in queries:
        candidates = by_query[query["id"]].get("candidates")
        expected = {entry["id"] for entry in query["usable"]}
        require(isinstance(candidates, list) and len(candidates) == len(expected), "score candidates mismatch")
        scores = {}
        for candidate in candidates:
            require(isinstance(candidate, dict) and valid_id(candidate.get("id")) and
                    candidate["id"] in expected and
                    candidate["id"] not in scores, "score candidates must be unique and match corpus")
            pair = [candidate.get("scoreRu"), candidate.get("scoreEn")]
            require(all(type(value) in (int, float) and math.isfinite(value) and -1.001 <= value <= 1.001
                        for value in pair), "scores must be finite cosine values")
            scores[candidate["id"]] = pair
        result[query["id"]] = scores
    return result


def read_images(root, queries):
    require(root.is_dir(), "images root must be an existing local directory")
    images, total = {}, 0
    for query in queries:
        for entry in query["usable"]:
            with local_file(root, entry["file"]).open("rb") as stream:
                raw = stream.read(IMAGE_LIMIT + 1)
            require(len(raw) == entry["bytes"] and digest(raw) == entry["sha256"], "image hash mismatch")
            total += len(raw)
            require(total <= TOTAL_IMAGE_LIMIT, "corpus exceeds total image byte limit")
            images[(query["id"], entry["id"])] = raw
    return images


def check_model(root, manifest_path):
    require(root.is_dir(), "model must be an existing local directory")
    manifest, manifest_hash = load_json(manifest_path, "model manifest")
    require(isinstance(manifest.get("modelId"), str) and 0 < len(manifest["modelId"]) <= 200 and
            isinstance(manifest.get("revision"), str) and
            re.fullmatch(r"[0-9a-f]{40}", manifest["revision"]) is not None and
            isinstance(manifest.get("license"), str) and 0 < len(manifest["license"]) <= 100,
            "model manifest must identify revision and license")
    files = manifest.get("files")
    require(isinstance(files, list) and len(files) == len(MODEL_FILES), "invalid model file manifest")
    require(all(isinstance(item, dict) and isinstance(item.get("file"), str) for item in files),
            "invalid model file entry")
    require({item["file"] for item in files} == MODEL_FILES, "model requires local safe tensor and tokenizer files")
    total = 0
    for item in files:
        require(valid_hash(item.get("sha256")) and positive_int(item.get("bytes"), MODEL_LIMIT),
                "invalid model hash or size")
        total += item["bytes"]
        require(total <= MODEL_LIMIT, "model exceeds byte limit")
        target = local_file(root, item["file"])
        require(target.stat().st_size == item["bytes"], "model size mismatch")
        sha = hashlib.sha256()
        bytes_read = 0
        with target.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                bytes_read += len(chunk)
                require(bytes_read <= item["bytes"], "model grew beyond its size bound")
                sha.update(chunk)
        require(sha.hexdigest() == item["sha256"], "model hash mismatch")
    config, _ = load_json(root / "open_clip_config.json", "model config")
    cfg = config.get("model_cfg", {})
    require(isinstance(cfg, dict) and isinstance(cfg.get("vision_cfg"), dict) and
            cfg["vision_cfg"].get("timm_model_pretrained") is False,
            "model must disable pretrained image downloads")
    require(isinstance(cfg.get("text_cfg"), dict) and not cfg["text_cfg"].get("hf_model_name"),
            "remote text-model loading is unsupported")
    return {key: manifest.get(key) for key in ("modelId", "revision", "license")}, manifest_hash


def rss_to_bytes(value, platform_name):
    if platform_name == "darwin":
        return int(value)
    if platform_name.startswith("linux"):
        return int(value * 1024)
    return None


def peak_rss():
    try:
        import resource
        return rss_to_bytes(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, sys.platform)
    except ImportError:
        return None


def infer(model_root, queries, images, batch_size, threads):
    # Set these before importing any optional package. Only local-dir is passed to OpenCLIP.
    for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "HF_HUB_DISABLE_IMPLICIT_TOKEN"):
        os.environ[key] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    start = time.perf_counter()
    try:
        import torch
        import open_clip
        from PIL import Image
    except ImportError as error:
        raise MissingDependencies("Optional dependencies unavailable. Use a separate environment with the documented pins; no packages were installed. --metrics-only needs only Python.") from error
    imports_seconds = time.perf_counter() - start
    torch.set_num_threads(threads)
    torch.manual_seed(7)
    Image.MAX_IMAGE_PIXELS = 16_000_000
    start = time.perf_counter()
    model, preprocess = open_clip.create_model_from_pretrained(
        "local-dir:" + str(model_root.resolve()), device="cpu", precision="fp32")
    tokenizer = open_clip.get_tokenizer("local-dir:" + str(model_root.resolve()))
    model.eval()
    model_seconds = time.perf_counter() - start
    result, query_seconds = {}, {}
    with torch.inference_mode():
        for query in queries:
            start = time.perf_counter()
            ids = [entry["id"] for entry in query["usable"]]
            features = []
            for offset in range(0, len(ids), batch_size):
                batch = []
                for aid in ids[offset:offset + batch_size]:
                    with Image.open(io.BytesIO(images[(query["id"], aid)])) as image:
                        require(image.width * image.height <= 16_000_000, "image exceeds pixel limit")
                        batch.append(preprocess(image.convert("RGB")))
                features.append(model.encode_image(torch.stack(batch), normalize=True))
            text = model.encode_text(tokenizer([query["ru"], query["en"]]), normalize=True)
            similarities = (torch.cat(features) @ text.T).tolist()
            require(all(math.isfinite(value) for pair in similarities for value in pair), "non-finite model score")
            result[query["id"]] = dict(zip(ids, similarities))
            query_seconds[query["id"]] = time.perf_counter() - start
    return result, {"importsSeconds": imports_seconds, "modelSeconds": model_seconds,
                    "querySeconds": query_seconds, "peakRssBytes": peak_rss(),
                    "parameterCount": sum(p.numel() for p in model.parameters()),
                    "device": "cpu", "precision": "fp32", "threads": threads, "batchSize": batch_size,
                    "python": sys.version.split()[0], "torch": torch.__version__, "openClip": open_clip.__version__}


def metrics(ranked, grades):
    top = ranked[:5]
    return {"ids": top, "grades": [grades[aid] for aid in top],
            "meanRelevanceAt5": sum(grades[aid] for aid in top) / 5,
            "precisionAt5": sum(grades[aid] >= 2 for aid in top) / 5,
            "top1Relevance": grades[top[0]]}


def summarize(queries, scores):
    rows = []
    for query in queries:
        ids = [entry["id"] for entry in query["usable"]]
        pair = scores[query["id"]]
        orders = [ids, sorted(ids, key=lambda aid: -pair[aid][0]),
                  sorted(ids, key=lambda aid: -pair[aid][1]),
                  sorted(ids, key=lambda aid: -sum(pair[aid]) / 2)]
        row = {"id": query["id"], "candidateCount": len(ids),
               "excludedCount": len(query["candidates"]) - len(ids),
               "candidates": [{"id": entry["id"], "providerRank": entry["providerRank"],
                               "blindTag": query["tagById"][entry["id"]],
                               "grade": query["gradeById"][entry["id"]],
                               "scoreRu": pair[entry["id"]][0], "scoreEn": pair[entry["id"]][1]}
                              for entry in query["usable"]]}
        row.update({name: metrics(order, query["gradeById"]) for name, order in zip(METHODS, orders)})
        rows.append(row)
    macro = {name: {key: sum(row[name][key] for row in rows) / len(rows)
                    for key in ("meanRelevanceAt5", "precisionAt5", "top1Relevance")}
             for name in METHODS}
    return rows, macro


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("corpus", "labels", "blind-map", "output"):
        parser.add_argument("--" + flag, required=True, type=Path)
    parser.add_argument("--metrics-only", action="store_true", help="replay saved scores without images, models, or optional packages")
    parser.add_argument("--scores", type=Path)
    parser.add_argument("--images-root", type=Path, help="directory containing corpus-relative image paths")
    parser.add_argument("--model", type=Path, help="existing local OpenCLIP model directory; never a hub ID")
    parser.add_argument("--model-manifest", type=Path, help="expected local model files, byte sizes and SHA-256")
    parser.add_argument("--batch-size", type=int, choices=range(1, 9), default=4)
    parser.add_argument("--threads", type=int, choices=range(1, 9), default=4)
    args = parser.parse_args(argv)
    started = time.perf_counter()
    require(not args.output.exists(), "output already exists; choose a new result path")
    corpus, queries, hashes = load_evidence(args.corpus, args.labels, args.blind_map)
    details = {}
    if args.metrics_only:
        require(args.scores is not None, "--metrics-only requires --scores")
        scores = load_scores(args.scores, queries, hashes)
    else:
        require(args.images_root is not None and args.model is not None and args.model_manifest is not None,
                "inference requires --images-root, --model and --model-manifest")
        images = read_images(args.images_root, queries)
        model, model_hash = check_model(args.model, args.model_manifest)
        scores, measurements = infer(args.model, queries, images, args.batch_size, args.threads)
        details = {"model": model, "modelManifestSha256": model_hash, "measurements": measurements}
    rows, macro = summarize(queries, scores)
    result = {"schemaVersion": 1, "mode": "metrics-only" if args.metrics_only else "inference",
              "provider": corpus.get("provider"), "inputHashes": hashes,
              "queries": rows, "macroMetrics": macro, **details,
              "totalSeconds": time.perf_counter() - started}
    encoded = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with args.output.open("x", encoding="utf-8") as stream:
            stream.write(encoded)
    except FileExistsError as error:
        raise BenchmarkError("output already exists; choose a new result path") from error
    print(json.dumps({"mode": result["mode"], "queries": len(rows), "macroMetrics": macro}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except MissingDependencies as error:
        print(str(error), file=sys.stderr)
        sys.exit(3)
    except (BenchmarkError, OSError, ValueError, RuntimeError) as error:
        print("Benchmark error: " + str(error), file=sys.stderr)
        sys.exit(2)
